/*
 *  Phusion Passenger - https://www.phusionpassenger.com/
 *  Copyright (c) 2011-2015 Phusion Holding B.V.
 *
 *  "Passenger", "Phusion Passenger" and "Union Station" are registered
 *  trademarks of Phusion Holding B.V.
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
#ifndef _PASSENGER_REQUEST_HANDLER_REQUEST_H_
#define _PASSENGER_REQUEST_HANDLER_REQUEST_H_

#include <ev++.h>
#include <string>
#include <cstring>

#include <ServerKit/HttpRequest.h>
#include <ServerKit/FdSinkChannel.h>
#include <ServerKit/FdSourceChannel.h>
#include <Logging.h>
#include <Core/ApplicationPool/Pool.h>
#include <Core/UnionStation/Core.h>
#include <Core/UnionStation/Transaction.h>
#include <Core/UnionStation/StopwatchLog.h>
#include <Core/Controller/AppResponse.h>

namespace Passenger {
namespace Core {

using namespace std;
using namespace boost;
using namespace ApplicationPool2;


class Request: public ServerKit::BaseHttpRequest {
public:
	enum State {
		ANALYZING_REQUEST,
		BUFFERING_REQUEST_BODY,
		CHECKING_OUT_SESSION,
		SENDING_HEADER_TO_APP,
		FORWARDING_BODY_TO_APP,
		WAITING_FOR_APP_OUTPUT
	};

	ev_tstamp startedAt;

	State state: 3;
	bool dechunkResponse: 1;
	bool requestBodyBuffering: 1;
	bool https: 1;
	bool stickySession: 1;
	bool halfCloseAppConnection: 1;

	// Range: 0..MAX_SESSION_CHECKOUT_TRY
	boost::uint8_t sessionCheckoutTry;
	bool appResponseInitialized: 1;
	bool strip100ContinueHeader: 1;
	bool hasPragmaHeader: 1;

	Options options;
	SessionPtr session;
	const LString *host;

	ServerKit::FdSinkChannel appSink;
	ServerKit::FdSourceChannel appSource;
	AppResponse appResponse;

	ServerKit::FileBufferedChannel bodyBuffer;
	boost::uint64_t bodyBytesBuffered; // After dechunking

	struct {
		UnionStation::StopwatchLog *requestProcessing;
		UnionStation::StopwatchLog *bufferingRequestBody;
		UnionStation::StopwatchLog *getFromPool;
		UnionStation::StopwatchLog *requestProxying;
	} stopwatchLogs;

	HashedStaticString cacheKey;
	LString *cacheControl;
	LString *varyCookie;
	// Value of the `!~PASSENGER_ENV_VARS` header. This is different
	// from `options.environmentVariables`. If `!~PASSENGER_ENV_VARS`
	// is not set or is empty, then `envvars` is NULL, while
	// `options.environmentVariables` retains a previous value.
	//
	// This value is guaranteed to be contiguous.
	LString *envvars;

	#ifdef DEBUG_CC_EVENT_LOOP_BLOCKING
		bool timedAppPoolGet;
		ev_tstamp timeBeforeAccessingApplicationPool;
		ev_tstamp timeOnRequestHeaderSent;
		ev_tstamp timeOnResponseBegun;
	#endif


	Request()
		: BaseHttpRequest()
	{
		memset(&stopwatchLogs, 0, sizeof(stopwatchLogs));
	}

	const char *getStateString() const {
		switch (state) {
		case ANALYZING_REQUEST:
			return "ANALYZING_REQUEST";
		case BUFFERING_REQUEST_BODY:
			return "BUFFERING_REQUEST_BODY";
		case CHECKING_OUT_SESSION:
			return "CHECKING_OUT_SESSION";
		case SENDING_HEADER_TO_APP:
			return "SENDING_HEADER_TO_APP";
		case FORWARDING_BODY_TO_APP:
			return "FORWARDING_BODY_TO_APP";
		case WAITING_FOR_APP_OUTPUT:
			return "WAITING_FOR_APP_OUTPUT";
		default:
			return "UNKNOWN";
		}
	}

	bool useUnionStation() const {
		return options.transaction != NULL;
	}

	void beginStopwatchLog(UnionStation::StopwatchLog **stopwatchLog, const char *name) {
		if (options.transaction != NULL) {
			*stopwatchLog = new UnionStation::StopwatchLog(options.transaction, name);
		}
	}

	void endStopwatchLog(UnionStation::StopwatchLog **stopwatchLog, bool success = true) {
		if (success && *stopwatchLog != NULL) {
			(*stopwatchLog)->success();
		}
		delete *stopwatchLog;
		*stopwatchLog = NULL;
	}

	void logMessage(const StaticString &message) {
		options.transaction->message(message);
	}

	DEFINE_SERVER_KIT_BASE_HTTP_REQUEST_FOOTER(Passenger::Core::Request);
};


} // namespace Core
} // namespace Passenger

#endif /* _PASSENGER_REQUEST_HANDLER_REQUEST_H_ */
