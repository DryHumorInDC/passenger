/*
 *  Phusion Passenger - https://www.phusionpassenger.com/
 *  Copyright (c) 2010-2015 Phusion
 *
 *  "Phusion Passenger" is a trademark of Hongli Lai & Ninh Bui.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 */

var log;
var net = require('net');
var os = require("os");
var nbo = require('network-byte-order');
var codify = require('codify');
var microtime = require('microtime');

var ustRouterAddress; // standalone = "localhost:9344";
var ustRouterUser;
var ustRouterPass;
var ustGatewayKey;

var nodeName = os.hostname();
var appGroupName;

var routerConn;
var routerState = -1;
// -1: disabled (not initialized or unrecoverable error, won't try to reconnect without new init)
// 0: disconnected, ready to (re)try connect
// 1: awaiting connect
// 2: awaiting version
// 3: awaiting auth OK
// 4: awaiting init OK
// 5: idle / ready to send
// 6: awaiting openTransaction OK
// 7: awaiting closeTransaction OK

var pendingTxnBuf = [];
var pendingTxnBufMaxLength = 5000;
var connTimeoutMs = 10000;

// Call to initiate a connection with the UstRouter. If called with incomplete parameters the connector will just be
// disabled (isEnabled() will return false) and no further actions will be taken. If the connection fails, it is auto-retried
// whenever logToUstTransaction(..) is called.
exports.init = function(logger, routerAddress, routerUser, routerPass, gatewayKey, groupName) {
	log = logger;
	if (routerState > 0) {
		log.warn("Trying to init when routerState > 0! (ignoring)");
		return;
	}
	
	routerState = -1;
	ustRouterAddress = routerAddress;
	ustRouterUser = routerUser;
	ustRouterPass = routerPass;
	ustGatewayKey = gatewayKey;
	appGroupName = groupName;
	
	// createConnection doesn't understand the "unix:" prefix, but it does understand the path that follows.
	if (ustRouterAddress.indexOf("unix:") == 0) {
		ustRouterAddress = ustRouterAddress.substring(5);
	}
	log.debug("initialize ustrouter_connector with [routerAddress:" + ustRouterAddress + "] [user:" + ustRouterUser + "] [pass:" + ustRouterPass + "] [key:" + 
		ustGatewayKey + "] [app:" + appGroupName + "]");

	if (!ustRouterAddress || !ustRouterUser || !ustRouterPass || !ustGatewayKey || !appGroupName) {
		log.verbose("Union Station logging disabled (incomplete configuration).");
		return;
	}
	
	changeState(0, "Init approved");
	
	beginConnection();
}

exports.isEnabled = function() {
	return routerState >= 0;
}

function beginConnection() {
	changeState(1);

	setWatchdog(connTimeoutMs); // Watchdog for the entire connect-to-ustRouter process.
	
	routerConn = net.createConnection(ustRouterAddress);

	routerConn.on("connect", onConnect);
	routerConn.on("error", onError);
	routerConn.on("end", onEnd);
	routerConn.on("data", onData);
}

function onConnect() {
	changeState(2);
}

function onError(e) {
	if (routerState == 1) {
		log.error("Unable to connect to UstRouter at [" + ustRouterAddress +"], will auto-retry.");
	} else {
		log.error("Unexpected error in UstRouter connection: " + e + ", will auto-retry.");
	}
	changeState(0, "onError");
}

function onEnd() {
	changeState(0, "onEnd");
}

exports.getTxnIdFromRequest = function(req) {
	return req.headers['passenger-txn-id'];
}

function LogTransaction(cat) {
	this.timestamp = microtime.now();
	this.category = cat;
	this.txnId = "";
	this.logBuf = [];
	this.state = 1;
}

// Example categories are "requests", "exceptions". The lineArray is a specific format parsed by Union STation.
// txnIfContinue is an optional txnId and attaches the log to an existing transaction with the specified txnId.
// N.B. transactions will be dropped if the outgoing buffer limit is reached.
exports.logToUstTransaction = function(category, lineArray, txnIfContinue) {
	if (!this.isEnabled()) {
		return;
	}
	
	if (pendingTxnBuf.length < pendingTxnBufMaxLength) {
		var logTxn = new LogTransaction(category);
		
		if (txnIfContinue) {
			logTxn.txnId = txnIfContinue;
		}
		logTxn.logBuf = lineArray;
		
		pendingTxnBuf.push(logTxn);
	} else {
		log.debug("Dropping transaction due to outgoing buffer limit (" + pendingTxnBufMaxLength + ") reached");
	}
	
	pushPendingData();
}

function verifyOk(rcvString, topic) {
	if ("status" != rcvString[0] || "ok" != rcvString[1]) {
		log.error("Error with " + topic + ": [" + rcvString + "], will auto-retry.");
		changeState(0, "not OK reply");
		return false;
	}
	return true;
}

function pushPendingData() {
	log.debug("pushPendingData");

	if (routerState == 0) {
		// it disconnected or crashed somehow, reconnect
		beginConnection();
		return;
	} else if (routerState != 5) {
		return; // we're not ready to send
	}

	// we have an authenticated, active connection; see what we can send
	if (pendingTxnBuf.length == 0) {
		return; // no pending
	}
	
	if (pendingTxnBuf[0].state == 1) {
		// still need to open the txn
		changeState(6); // expect ok/txnid in onData()..
		setWatchdog(connTimeoutMs);
		log.debug("open transaction(" + pendingTxnBuf[0].txnId + ")");
		writeLenArray(routerConn, "openTransaction\0" + pendingTxnBuf[0].txnId + "\0" + appGroupName + "\0" + nodeName + "\0" + 
			pendingTxnBuf[0].category +	"\0" + codify.toCode(pendingTxnBuf[0].timestamp) + "\0" + ustGatewayKey + "\0true\0true\0\0");
	} else {
		// txn is open, log the data & close
		log.debug("log & close transaction(" + pendingTxnBuf[0].txnId + ")");
		txn = pendingTxnBuf.shift();
		for (i = 0; i < txn.logBuf.length; i++) {
			writeLenArray(routerConn, "log\0" + txn.txnId + "\0" + codify.toCode(txn.timestamp) + "\0");
			writeLenString(routerConn, txn.logBuf[i]);
		}

		changeState(7); // expect ok in onData()..
		setWatchdog(connTimeoutMs);
		writeLenArray(routerConn, "closeTransaction\0" + txn.txnId + "\0" + codify.toCode(microtime.now()) + "\0true\0");
	}	
}

var watchDogId;

function onWatchdogTimeout() {
	changeState(0, "onWatchdogTimeout");
}

// Resets the connection if there is no progress in the next timeoutMs.
function setWatchdog(timeoutMs) {
	if (watchDogId) {
		resetWatchdog();
	}
	watchDogId = setTimeout(onWatchdogTimeout, timeoutMs);
}

function resetWatchdog() {
	if (watchDogId) {
		clearTimeout(watchDogId);
		watchDogId = null;
	}
}

var readBuf = "";
// N.B. newData may be partial!
function readLenArray(newData) {
	readBuf += newData;
	log.silly("read: total len = " + readBuf.length);
	log.silly(new Buffer(readBuf));
	if (readBuf.length < 2) {
	log.silly("need more header data..");
		return null; // expecting at least length bytes
	}
	lenRcv = nbo.ntohs(new Buffer(readBuf), 0);
	log.silly("read: lenRCv = " + lenRcv);
	if (readBuf.length < 2 + lenRcv) {
	log.silly("need more payload data..");
		return null; // not fully read yet
	}
	resultStr = readBuf.substring(2, lenRcv + 2);
	readBuf = readBuf.substring(lenRcv + 2); // keep any bytes read beyond length for next read
	
	return resultStr.split("\0");
}

function onData(data) {
	log.silly("onData [" + data + "] (len = " + data.length + ")");
	
	rcvString = readLenArray(data);
	if (!rcvString) {
		return;
	}
	
	log.silly("got: [" + rcvString + "]");

	switch (routerState) {
		case 2:
			if ("version" == rcvString[0] && "1" == rcvString[1]) {
				changeState(3);

				writeLenString(routerConn, ustRouterUser);
				writeLenString(routerConn, ustRouterPass);
			} else {
				log.error("Error with UstRouter version: [" + rcvString + "], will auto-retry.");
				changeState(0, "not OK reply");
			}
			break;

		case 3:
			if (verifyOk(rcvString, "UstRouter authentication")) {
				changeState(4);
				writeLenArray(routerConn, "init\0" + nodeName + "\0");
			}
			break;

		case 4:
			if (verifyOk(rcvString, "UstRouter initialization")) {
				resetWatchdog(); // initialization done, lift the watchdog guard
				changeState(5);
				pushPendingData();
			}
			break;

		case 5:
			log.warn("unexpected data receive state (5)");
	 		pushPendingData();
	 		break;

		case 6:
			resetWatchdog();
			if (verifyOk(rcvString, "UstRouter openTransaction")) {
				pendingTxnBuf[0].state = 2;
				if (pendingTxnBuf[0].txnId.length == 0) {
					log.debug("use rcvd back txnId: " + rcvString[2]);
					pendingTxnBuf[0].txnId = rcvString[2]; // fill in the txn from the UstRouter reply
				}

				changeState(5);
				pushPendingData();
			}
			break;

		case 7:
			resetWatchdog();
			if (verifyOk(rcvString, "UstRouter closeTransaction")) {
				changeState(5);
				pushPendingData();
			}
			break;
	}
}

function changeState(newRouterState, optReason) {
	log.debug("routerState: " + routerState + " -> " + newRouterState + (optReason ? " due to: " + optReason : ""));
	
	routerState = newRouterState;
	if (newRouterState == 0) {
		// If the old state was mid-transaction (routerState 6 or 7), we don't really know what the other side remembers
		// about the transaction (e.g. nothing if it crashed). On our side we choose to just reconnect and continue
		// where we left off (e.g. resend the pushPendingData after reconnect pendingTxnBuf[0].state 2
		  
		// ensure connection is finished and we don't get any outdated triggers 
		resetWatchdog();
		
		if (routerConn) {
			routerConn.destroy();
		}
	}
}

function writeLenString(c, str) {
	len = new Buffer(4);
	nbo.htonl(len, 0, str.length);
	c.write(len);
	c.write(str);
}

function writeLenArray(c, str) {
	len = new Buffer(2);
	nbo.htons(len, 0, str.length);
	c.write(len);
	c.write(str);
}
