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
 * One login, one pull: the group, its members, and the sessions still to come.
 *
 * What the page runs on. Nothing writes it to a sheet - Export.gs turns it
 * into the payload and the browser does the rest. See pullHistory_ at the
 * bottom of this file for the same fetch pointed backwards.
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
    // Which of the club's groups each member is in. Split here rather than in
    // the caller because the raw subGroups arrays are the one thing this
    // function throws away, and re-fetching the group to get them back would
    // be a second login. See subgroupBlocks_ in Groups.gs.
    groups: subgroupBlocks_(group),
  };
}

/**
 * Every event Spond has between two dates, fetched a chunk at a time.
 *
 * `sponds/` takes a `max` and offers no offset - there is no paging - so a
 * window holding more events than `max` comes back truncated, silently and
 * with a 200. Three sessions a week for a year is over 150; CONFIG.maxEvents
 * is 100. Asking for the year in one request would quietly lose a third of it
 * and the tab would look fine.
 *
 * Walking the window in fixed chunks sidesteps the question rather than
 * answering it: each request covers a few weeks, far under any plausible cap,
 * and it does not matter what Spond's real server-side limit turns out to be.
 * Results are merged by event id because spondDayStamp_ has day resolution and
 * both bounds are inclusive, so consecutive chunks genuinely do overlap by a
 * day.
 *
 * A chunk that comes back exactly full is the one case this cannot rule out,
 * so it says so rather than guessing - shrink historyChunkDays if it appears.
 */
function spondEventsBetween_(token, groupId, from, to) {
  var day = 86400000;
  // Guarded because a zero or negative chunk would never advance the cursor,
  // and an infinite loop here means a six-minute execution timeout.
  var chunk = Math.max(1, CONFIG.historyChunkDays) * day;

  var byId = {};
  var cursor = from.getTime();
  var end = to.getTime();

  while (cursor < end) {
    var chunkEnd = Math.min(cursor + chunk, end);
    var events =
      spondGet_('sponds/', token, {
        max: String(CONFIG.maxEvents),
        scheduled: 'true',
        groupId: groupId,
        minStartTimestamp: spondDayStamp_(new Date(cursor)),
        maxStartTimestamp: spondDayStamp_(new Date(chunkEnd)),
      }) || [];

    if (events.length >= CONFIG.maxEvents) {
      console.warn(
        'A %s-day chunk returned %s events, the requested maximum - it may ' +
        'have been truncated. Lower historyChunkDays in Config.gs.',
        CONFIG.historyChunkDays,
        events.length
      );
    }

    events.forEach(function (event) {
      if (event.id) {
        byId[event.id] = event;
      }
    });

    cursor = chunkEnd;
  }

  return Object.keys(byId).map(function (id) {
    return byId[id];
  });
}

/**
 * One login, one pull: the group and every matching session behind us.
 *
 * The mirror image of pullSnapshot_, and separate from it on purpose. The two
 * differ in the one line that matters - that one drops sessions that have
 * already started, this one keeps only those - and folding them together
 * behind a flag would put the inverted test somewhere a reader has to hold
 * both meanings in their head at once.
 *
 * The shape it returns is Snapshot plus a `from`/`to`, so everything already
 * written against a snapshot (subgroupBlocks_, applyGroupLevels_, fullName_)
 * works on it unchanged.
 *
 * What it counts is a Spond RESPONSE, not a check-in. Somebody who accepts and
 * stays home is counted as having attended, and somebody who turns up without
 * signing up is not counted at all. The tab says so out loud, because that
 * gap is the coach's to close by hand and cannot be closed here.
 */
function pullHistory_() {
  var now = new Date();
  var from = new Date(now.getTime() - CONFIG.historyDays * 86400000);

  var token = spondLogin_();

  var groups = spondGet_('groups/', token) || [];
  if (!groups.length) {
    throw new Error('Spond returned no groups for this login.');
  }
  var group = findGroup_(groups, CONFIG.groupName);
  var rowers = rowersFromGroup_(group);

  var events = spondEventsBetween_(token, group.id, from, now);

  var sessions = [];
  for (var i = 0; i < events.length; i++) {
    if (!matchesTitle_(events[i].heading, CONFIG.eventTitleMatches)) {
      continue;
    }
    var session = sessionFromEvent_(events[i]);
    // The last chunk ends today, and Spond's filter is day-resolution, so a
    // session later this evening arrives with the ones already rowed. Nobody
    // has attended it yet.
    if (!session || session.start > now) {
      continue;
    }
    sessions.push(session);
  }
  sessions.sort(function (a, b) {
    return a.start - b.start;
  });

  // Over a year, the people who responded but are not in the member list now
  // are mostly former members and guests, and there can be a lot of them -
  // each one costs a request. Only those who actually turned up are worth a
  // name: somebody who was invited, never answered, and has since left is a
  // row of zeroes, and the tab drops them for that reason anyway.
  var unknown = {};
  sessions.forEach(function (session) {
    Object.keys(session.responses).forEach(function (rowerId) {
      if (!rowers[rowerId] && session.responses[rowerId] === 'accepted') {
        unknown[rowerId] = true;
      }
    });
  });
  Object.keys(unknown).forEach(function (rowerId) {
    var person = {};
    try {
      person = spondGet_('profile/' + rowerId, token) || {};
    } catch (err) {
      // An unresolvable id still belongs in the count - fullName_ falls back
      // to showing the id itself.
      person = {};
    }
    rowers[rowerId] = {
      id: rowerId,
      firstName: person.firstName || '',
      lastName: person.lastName || '',
      // Flagged rather than dropped: they rowed, so their sessions happened,
      // but they are not on the roster a coach is picking a crew from.
      formerMember: true,
    };
  });

  return {
    fetchedAt: now,
    from: from,
    to: now,
    groupName: group.name || CONFIG.groupName,
    rowers: rowers,
    sessions: sessions,
    groups: subgroupBlocks_(group),
  };
}
