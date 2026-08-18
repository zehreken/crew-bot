/**
 * Writing a snapshot to the Attendance tab - a port of the relevant half of
 * src/crew_bot/sheets.py.
 *
 * SpreadsheetApp needs no credentials at all: the script runs as its owner,
 * who already has access to the sheet. There is no service account key here
 * and no OAuth dance - that whole layer disappears on this side.
 *
 * The functions without a trailing underscore are the ones that show up in the
 * Run dropdown in the editor. They are the entry points; everything else is
 * hidden from it deliberately.
 */

// Same columns, same order, as HEADER in sheets.py.
var ATTENDANCE_HEADER = [
  'session_id',
  'start',
  'end',
  'heading',
  'rower_id',
  'name',
  'response',
];

/**
 * A Date as the Python writes it: UTC, ISO-8601, with an explicit +00:00.
 *
 * toISOString gives "...T16:00:00.000Z", datetime.isoformat gives
 * "...T16:00:00+00:00". Matching the Python exactly means the two tabs can be
 * diffed cell for cell while both implementations exist, which is the whole
 * point of this first step.
 */
function isoUtc_(date) {
  if (!date) {
    return '';
  }
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** The tab to write to, created if it does not exist yet. */
function attendanceSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.worksheetName);
  return sheet || spreadsheet.insertSheet(CONFIG.worksheetName);
}

/** One row per session x rower, sorted by name within a session. */
function snapshotToRows_(snapshot) {
  var rows = [ATTENDANCE_HEADER];

  snapshot.sessions.forEach(function (session) {
    var start = isoUtc_(session.start);
    var end = isoUtc_(session.end);

    // compareNames_, not localeCompare: the Python sorts by code point, and
    // matching it is what lets the two tabs be diffed.
    var rowerIds = Object.keys(session.responses).sort(function (a, b) {
      return compareNames_(
        fullName_(snapshot.rowers[a]) || a,
        fullName_(snapshot.rowers[b]) || b
      );
    });

    rowerIds.forEach(function (rowerId) {
      rows.push([
        session.id,
        start,
        end,
        session.heading,
        rowerId,
        fullName_(snapshot.rowers[rowerId]) || rowerId,
        session.responses[rowerId],
      ]);
    });
  });

  return rows;
}

/**
 * Replace the tab's contents. Returns the number of data rows written.
 *
 * One clear and one batched setValues, rather than per-cell writes: the same
 * reason the Python batches, since every call here is a round trip too.
 * Replacing rather than appending is what makes re-running safe.
 */
function writeSnapshot_(sheet, snapshot) {
  var rows = snapshotToRows_(snapshot);
  sheet.clear();
  sheet.getRange(1, 1, rows.length, ATTENDANCE_HEADER.length).setValues(rows);
  return rows.length - 1;
}

/**
 * Entry point: pull from Spond and write the Attendance tab.
 *
 * This is the whole proof - Google reaches Spond, and Google writes the sheet.
 */
function pullAttendance() {
  var snapshot = pullSnapshot_();
  var sheet = attendanceSheet_(openSpreadsheet_());
  var written = writeSnapshot_(sheet, snapshot);

  console.log('Group: %s', snapshot.groupName);
  console.log('Rowers known: %s', Object.keys(snapshot.rowers).length);
  console.log('Sessions matched: %s', snapshot.sessions.length);

  snapshot.sessions.forEach(function (session) {
    var counts = { accepted: 0, declined: 0, unanswered: 0 };
    Object.keys(session.responses).forEach(function (rowerId) {
      var status = session.responses[rowerId];
      if (counts[status] !== undefined) {
        counts[status] += 1;
      }
    });
    console.log(
      '  %s  %s  accepted %s  declined %s  unanswered %s',
      Utilities.formatDate(session.start, CONFIG.timeZone, 'EEE dd MMM HH:mm'),
      session.heading,
      counts.accepted,
      counts.declined,
      counts.unanswered
    );
  });

  console.log('Wrote %s rows to "%s".', written, CONFIG.worksheetName);

  if (!snapshot.sessions.length) {
    console.log(
      'No sessions matched. Run listEventTitles to see what your events are ' +
      'actually called, then fix eventTitleMatches in Config.gs.'
    );
  }
  return written;
}

/**
 * Diagnostic: the Spond groups this login can see.
 *
 * Run this first. It proves the login works and that UrlFetchApp can reach
 * Spond, without touching the spreadsheet at all - so a failure here is
 * unambiguously about Spond, not about Google.
 */
function listGroups() {
  var token = spondLogin_();
  var groups = spondGet_('groups/', token) || [];
  if (!groups.length) {
    console.log('This login can not see any Spond groups.');
    return;
  }
  console.log('Groups this login can see:');
  groups
    .map(function (g) {
      return g.name || '?';
    })
    .sort()
    .forEach(function (name) {
      console.log('  %s', name);
    });
}

/**
 * Diagnostic: every upcoming event, with whether it currently matches.
 *
 * A filter matching nothing produces an empty tab rather than an error, so
 * this is the way to see what the events are really called.
 */
function listEventTitles() {
  var now = new Date();
  var windowEnd = new Date(now.getTime() + CONFIG.lookaheadDays * 86400000);

  var token = spondLogin_();
  var groups = spondGet_('groups/', token) || [];
  if (!groups.length) {
    throw new Error('Spond returned no groups for this login.');
  }
  var group = findGroup_(groups, CONFIG.groupName);

  var events =
    spondGet_('sponds/', token, {
      max: String(CONFIG.maxEvents),
      scheduled: 'true',
      groupId: group.id,
      minStartTimestamp: spondDayStamp_(now),
      maxStartTimestamp: spondDayStamp_(windowEnd),
    }) || [];

  var rows = [];
  events.forEach(function (event) {
    if (!event.startTimestamp) {
      return;
    }
    var start = new Date(event.startTimestamp);
    if (isNaN(start.getTime()) || start < now) {
      return;
    }
    var heading = String(event.heading || '').replace(/\s+/g, ' ').trim();
    rows.push({
      start: start,
      heading: heading,
      matches: matchesTitle_(heading, CONFIG.eventTitleMatches),
    });
  });
  rows.sort(function (a, b) {
    return a.start - b.start;
  });

  console.log('Upcoming events in "%s" (* = matches):', group.name);
  rows.forEach(function (row) {
    console.log(
      '  %s %s  %s',
      row.matches ? '*' : ' ',
      Utilities.formatDate(row.start, CONFIG.timeZone, 'EEE dd MMM HH:mm'),
      row.heading
    );
  });
  if (!rows.length) {
    console.log('  (none in the next %s days)', CONFIG.lookaheadDays);
  }
}
