/**
 * Everything that talks to Spond - a port of src/crew_bot/spond_client.py.
 *
 * This runs on Google's servers, not in the browser, which is the whole point:
 * api.spond.com sends CORS headers only for https://spond.com, so a page can
 * never call it directly. UrlFetchApp is an ordinary HTTPS client and CORS
 * does not apply to it, exactly as it does not apply to the Python.
 *
 * The credentials are read from Script Properties, exchanged for a token, and
 * both are dropped when the execution ends. NOTHING HERE MAY BE LOGGED. Apps
 * Script logs persist to Cloud Logging and stay visible indefinitely, so one
 * console.log of a payload would turn a transient password into a permanent
 * record of one.
 */

var SPOND_API = 'https://api.spond.com/core/v1/';

// Spond reports responses as five parallel lists of ids on each event.
var RESPONSE_KEYS = {
  acceptedIds: 'accepted',
  declinedIds: 'declined',
  unansweredIds: 'unanswered',
  unconfirmedIds: 'unconfirmed',
  waitinglistIds: 'waitinglist',
};

/**
 * Exchange the stored email and password for a bearer token.
 *
 * The password is needed exactly once, here. Every other call carries the
 * token instead, and the token is never stored - its whole life is this one
 * execution, so there is nothing to expire or revoke later.
 */
function spondLogin_() {
  var response = UrlFetchApp.fetch(SPOND_API + 'auth2/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      email: scriptProperty_('SPOND_USERNAME'),
      password: scriptProperty_('SPOND_PASSWORD'),
    }),
    // So a bad password produces our message rather than an opaque exception.
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    // The status only. Deliberately not the response body and never the
    // request: an error message is the easiest way to leak a credential into
    // a log by accident.
    throw new Error(
      'Spond login failed (HTTP ' + code + '). Check SPOND_USERNAME and ' +
      'SPOND_PASSWORD in Script Properties, and that the account has no ' +
      'two-factor login and did not sign up with Google/Apple/Facebook.'
    );
  }

  var body = JSON.parse(response.getContentText());
  var token = body.accessToken && body.accessToken.token;
  if (!token) {
    throw new Error('Spond login returned no access token.');
  }
  return token;
}

/** GET a Spond endpoint with the bearer token, returning parsed JSON. */
function spondGet_(path, token, params) {
  var url = SPOND_API + path;
  if (params) {
    var query = Object.keys(params)
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      })
      .join('&');
    if (query) {
      url += '?' + query;
    }
  }

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Spond GET ' + path + ' failed (HTTP ' + code + ').');
  }
  return JSON.parse(response.getContentText());
}

/** Lowercase and collapse whitespace, so titles compare forgivingly. */
function normalise_(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True if the heading contains any of the configured titles. */
function matchesTitle_(heading, wanted) {
  var normalised = normalise_(heading);
  return wanted.some(function (w) {
    var needle = normalise_(w);
    return needle !== '' && normalised.indexOf(needle) !== -1;
  });
}

/**
 * The timestamp format Spond's event filter wants.
 *
 * Note the hard-coded midnight: that is the format the API accepts, and it is
 * why the filter has day resolution only. Today's already-finished sessions
 * come back regardless and have to be dropped afterwards - see pullSnapshot_.
 */
function spondDayStamp_(date) {
  var pad = function (n) {
    return n < 10 ? '0' + n : String(n);
  };
  return (
    date.getUTCFullYear() +
    '-' +
    pad(date.getUTCMonth() + 1) +
    '-' +
    pad(date.getUTCDate()) +
    'T00:00:00.000Z'
  );
}

/** Find the configured group, listing the alternatives when it is missing. */
function findGroup_(groups, wanted) {
  var target = normalise_(wanted);
  for (var i = 0; i < groups.length; i++) {
    if (normalise_(groups[i].name) === target) {
      return groups[i];
    }
  }
  var available = groups
    .map(function (g) {
      return g.name || '?';
    })
    .sort()
    .join(', ');
  throw new Error(
    'No Spond group named "' + wanted + '". Groups this login can see: ' +
    (available || 'none') + '.'
  );
}

/** Build the id -> rower map from the group's member list. */
function rowersFromGroup_(group) {
  var rowers = {};
  var members = group.members || [];
  for (var i = 0; i < members.length; i++) {
    var member = members[i];
    if (!member.id) {
      continue;
    }
    rowers[member.id] = {
      id: member.id,
      firstName: member.firstName || '',
      lastName: member.lastName || '',
    };
  }
  return rowers;
}

/** Display name, falling back to the id so a row is never blank. */
function fullName_(rower) {
  if (!rower) {
    return '';
  }
  var name = ((rower.firstName || '') + ' ' + (rower.lastName || '')).trim();
  return name || rower.id;
}

/** One event into a session, or null if it is unusable. */
function sessionFromEvent_(event) {
  if (!event.id || !event.startTimestamp) {
    return null;
  }
  var start = new Date(event.startTimestamp);
  if (isNaN(start.getTime())) {
    return null;
  }

  var responses = {};
  var raw = event.responses || {};
  Object.keys(RESPONSE_KEYS).forEach(function (key) {
    (raw[key] || []).forEach(function (rowerId) {
      responses[rowerId] = RESPONSE_KEYS[key];
    });
  });

  return {
    id: event.id,
    heading: String(event.heading || '').replace(/\s+/g, ' ').trim(),
    start: start,
    end: event.endTimestamp ? new Date(event.endTimestamp) : null,
    responses: responses,
  };
}

/**
 * One login, one pull: the group, its members, and the matching sessions.
 *
 * Returns the same shape Snapshot has in models.py, so what this writes to the
 * sheet can be compared row for row with what the Python writes.
 */
function pullSnapshot_() {
  var now = new Date();
  var windowEnd = new Date(now.getTime() + CONFIG.lookaheadDays * 86400000);

  var token = spondLogin_();

  var groups = spondGet_('groups/', token) || [];
  if (!groups.length) {
    throw new Error('Spond returned no groups for this login.');
  }
  var group = findGroup_(groups, CONFIG.groupName);
  var rowers = rowersFromGroup_(group);

  var events =
    spondGet_('sponds/', token, {
      max: String(CONFIG.maxEvents),
      scheduled: 'true',
      groupId: group.id,
      minStartTimestamp: spondDayStamp_(now),
      maxStartTimestamp: spondDayStamp_(windowEnd),
    }) || [];

  var sessions = [];
  for (var i = 0; i < events.length; i++) {
    if (!matchesTitle_(events[i].heading, CONFIG.eventTitleMatches)) {
      continue;
    }
    var session = sessionFromEvent_(events[i]);
    // Spond's filter is day-resolution, so today's finished sessions arrive
    // too. Drop them here rather than showing a coach a session that is over.
    if (!session || session.start < now) {
      continue;
    }
    sessions.push(session);
  }
  sessions.sort(function (a, b) {
    return a.start - b.start;
  });

  // Guests and members of other groups can respond without appearing in this
  // group's member list. Look those up individually; there are usually none.
  var unknown = {};
  sessions.forEach(function (session) {
    Object.keys(session.responses).forEach(function (rowerId) {
      if (!rowers[rowerId]) {
        unknown[rowerId] = true;
      }
    });
  });
  Object.keys(unknown).forEach(function (rowerId) {
    var person = {};
    try {
      person = spondGet_('profile/' + rowerId, token) || {};
    } catch (err) {
      // An unresolvable id still belongs in the output - fullName_ falls back
      // to showing the id itself.
      person = {};
    }
    rowers[rowerId] = {
      id: rowerId,
      firstName: person.firstName || '',
      lastName: person.lastName || '',
    };
  });

  return {
    fetchedAt: now,
    groupName: group.name || CONFIG.groupName,
    rowers: rowers,
    sessions: sessions,
  };
}
