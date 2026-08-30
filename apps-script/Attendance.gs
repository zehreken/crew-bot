/**
 * The Attendance tab: how many sessions each rower has signed up for.
 *
 * This is a statistics tab, not part of getting anyone on the water. It exists
 * so a coach can pick the cleaning crews from the people who actually turn up,
 * which is a question about the past year rather than about next Thursday, and
 * so is the one thing here that reads Spond backwards. `pullHistory_` in
 * Spond.gs does the reading; this file counts and lays out.
 *
 * **It counts sign-ups, not check-ins.** Spond's answer to "did they attend?"
 * is the response list on the event - accepted, declined, no answer - and that
 * is what a rower pressed in the app, not what happened at the boathouse.
 * Somebody who accepts and stays home is counted here; somebody who rows every
 * week without ever answering the invitation is not. There is no fixing that
 * from this side, so the tab says it in its own second line and leaves the
 * adjusting to the coach who knows.
 *
 * This tab used to hold something else: one row per session per rower, the raw
 * dump the Python's Attendance sheet held, written straight out of the upcoming
 * snapshot. Nothing ever read it - the crew page calls pullSnapshot_ directly -
 * and it existed to be diffed against the Python during the port. The Python is
 * gone, so the dump went with it and the name went to something a coach uses.
 *
 * The functions without a trailing underscore are the ones that show up in the
 * Run dropdown in the editor. They are the entry points; everything else is
 * hidden from it deliberately.
 */

// Attended first, because it is the only column anyone reads down. Invited is
// the denominator and has to be there: somebody who joined the club in May has
// a small count for a reason that is not about them.
var ATTENDANCE_HEADER = [
  'Name',
  'Attended',
  'Declined',
  'No answer',
  'Invited',
  'Groups',
];

/**
 * Tally each rower's responses across the sessions.
 *
 * `invited` counts every session the rower appears in any response list at
 * all, which is not the sum of the other three: Spond also has `unconfirmed`
 * and `waitinglist`, and both mean the invitation reached them. Counting
 * invitations separately rather than adding up the columns is what keeps the
 * denominator honest when one of those turns up.
 */
function attendanceCounts_(sessions) {
  var counts = {};

  sessions.forEach(function (session) {
    Object.keys(session.responses).forEach(function (rowerId) {
      var tally = counts[rowerId];
      if (!tally) {
        tally = counts[rowerId] = {
          accepted: 0,
          declined: 0,
          unanswered: 0,
          invited: 0,
        };
      }
      tally.invited += 1;
      var status = session.responses[rowerId];
      if (tally[status] !== undefined) {
        tally[status] += 1;
      }
    });
  });

  return counts;
}

/**
 * Which of the club's groups each rower is in, id -> [group name].
 *
 * The same walk applyGroupLevels_ does over the same blocks. Kept separate
 * because this one wants the names to print and that one wants a level, and
 * sharing it would mean one of the two callers throwing half the result away.
 */
function groupMemberships_(snapshot) {
  var memberships = {};
  var blocks = (snapshot.groups && snapshot.groups.blocks) || [];
  blocks.forEach(function (block) {
    block.members.forEach(function (member) {
      if (!memberships[member.id]) {
        memberships[member.id] = [];
      }
      memberships[member.id].push(block.name);
    });
  });
  return memberships;
}

/**
 * One entry per rower who belongs on the tab, unsorted.
 *
 * Two kinds of person end up here. **Every current member of the group**, even
 * one with nothing but zeroes - a rower who has not been to a session all year
 * is exactly what a coach reads this tab to notice, and dropping them would
 * make the tab agree with itself while hiding the finding. And **anyone else
 * who attended at least once**: a former member, or a guest from another club.
 * They rowed, so their sessions happened; they are marked so nobody puts them
 * on a cleaning crew they have left the club to avoid.
 *
 * Somebody who is neither - invited a year ago, never answered, since gone -
 * is left out. pullHistory_ does not even look their name up, for the same
 * reason: a row of zeroes against a person who is not there is noise.
 */
function attendanceEntries_(snapshot) {
  var counts = attendanceCounts_(snapshot.sessions);
  var memberships = groupMemberships_(snapshot);
  var entries = [];

  Object.keys(snapshot.rowers).forEach(function (rowerId) {
    var rower = snapshot.rowers[rowerId];
    var tally = counts[rowerId] || {
      accepted: 0,
      declined: 0,
      unanswered: 0,
      invited: 0,
    };

    if (rower.formerMember && !tally.accepted) {
      return;
    }

    var groups = (memberships[rowerId] || []).join(', ');
    entries.push({
      id: rowerId,
      name: fullName_(rower) || rowerId,
      attended: tally.accepted,
      declined: tally.declined,
      unanswered: tally.unanswered,
      invited: tally.invited,
      // Said in the column rather than in a footnote, because this is read one
      // row at a time and a legend at the bottom would never be reached.
      groups: rower.formerMember ? 'no longer in the group' : groups,
      // The same fact as a flag, for the pane. It draws a row rather than a
      // cell and has nowhere to put a sentence, so it needs to ask rather than
      // match on the text above.
      former: !!rower.formerMember,
    });
  });

  return entries;
}

/**
 * Most sessions first, ties broken by name.
 *
 * The one place on this side that deliberately does NOT sort by name. Every
 * other tab is a list to look somebody up in; this one is a ranking, and the
 * question it answers - who has been to more than ten - is answered by reading
 * from the top until the count drops.
 */
function compareAttendance_(a, b) {
  if (a.attended !== b.attended) {
    return b.attended - a.attended;
  }
  return compareNamesIgnoringCase_(a.name, b.name);
}

/**
 * Everything the tab and the pane both need, and nothing neither can carry.
 *
 * A snapshot holds Dates and a year of sessions; this holds a formatted window
 * and a count. That is what lets the page ask for the numbers once, draw them,
 * and hand the same object back to be written to the sheet - without a second
 * year-long fetch, and without google.script.run having to serialise anything
 * but strings, numbers and plain objects.
 */
function attendanceReport_(snapshot, entries) {
  return {
    groupName: snapshot.groupName,
    window:
      Utilities.formatDate(snapshot.from, CONFIG.timeZone, 'd MMM yyyy') +
      ' to ' +
      Utilities.formatDate(snapshot.to, CONFIG.timeZone, 'd MMM yyyy'),
    sessionCount: snapshot.sessions.length,
    // Carried rather than read from CONFIG on the page, which cannot see it.
    threshold: CONFIG.attendanceThreshold,
    entries: entries,
  };
}

/**
 * Lay the entries out, with a divider where the threshold falls.
 *
 * The divider is the whole reason this is sorted by count. Everything above it
 * has been to more than CONFIG.attendanceThreshold sessions and everything
 * below has not, so the cleaning-crew list is "the rows above the line" rather
 * than something to be worked out cell by cell. It is dropped when it would be
 * the very first row - a line above the whole list separates it from nothing -
 * and never drawn at all when everybody is above the threshold.
 *
 * The banner says out loud that the tab is rebuilt from Spond. Boats sits near
 * it and is the opposite - typed in by hand - and there is nothing on screen
 * to tell them apart otherwise. It also states the window and what a count
 * really means, because both are invisible in the numbers themselves.
 */
function attendanceToRows_(report, updated) {
  var entries = report.entries || [];
  var threshold = report.threshold;

  var blank = ['', '', '', '', '', ''];
  var rows = [
    ['Attendance in ' + report.groupName, 'Updated ' + updated, '', '', '', ''],
    [
      report.window +
        ': ' +
        report.sessionCount +
        ' session' +
        (report.sessionCount === 1 ? '' : 's') +
        '. Rebuilt from Spond each run.',
      '', '', '', '', '',
    ],
    [
      'Counts are sign-ups in Spond, not check-ins - somebody who accepts and ' +
        'stays home is counted, somebody who rows without answering is not.',
      '', '', '', '', '',
    ],
    blank,
    ATTENDANCE_HEADER,
  ];

  var dividerAt = -1;
  entries.forEach(function (entry, i) {
    if (dividerAt === -1 && entry.attended <= threshold) {
      dividerAt = i;
    }
  });

  entries.forEach(function (entry, i) {
    if (i === dividerAt && i !== 0) {
      rows.push([threshold + ' sessions or fewer', '', '', '', '', '']);
    }
    rows.push([
      entry.name,
      entry.attended,
      entry.declined,
      entry.unanswered,
      entry.invited,
      entry.groups,
    ]);
  });

  return rows;
}

/**
 * Return the Attendance tab, creating it just after Groups if it is absent.
 *
 * Next to Groups because the two are read together: Groups says who is in the
 * club, this says which of them show up. An existing tab is never moved - by
 * then a coach has put it where they want it - which also means the old
 * session dump, if it is still in the sheet under this name, is reused and
 * overwritten in place rather than left behind as a stale twin.
 *
 * getIndex() is 1-based and insertSheet's index is 0-based, so passing the one
 * straight to the other lands immediately after.
 */
function ensureAttendanceTab_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.attendanceWorksheetName);
  if (sheet) {
    return sheet;
  }
  var groups = spreadsheet.getSheetByName(CONFIG.groupsWorksheetName);
  if (groups) {
    return spreadsheet.insertSheet(
      CONFIG.attendanceWorksheetName,
      groups.getIndex()
    );
  }
  return spreadsheet.insertSheet(CONFIG.attendanceWorksheetName);
}

/**
 * Replace the tab's contents. Returns the number of data rows written.
 *
 * One clear and one batched setValues rather than per-cell writes: every call
 * here is a round trip. Replacing rather than appending is what makes
 * re-running safe.
 *
 * The frozen header is the one piece of formatting on any tab, and it is here
 * because this is the only one long enough to scroll the header off the top -
 * a column of bare numbers with no heading in sight is unreadable.
 */
function writeAttendanceTab_(report) {
  var updated = Utilities.formatDate(
    new Date(),
    CONFIG.timeZone,
    'yyyy-MM-dd HH:mm'
  );
  var rows = attendanceToRows_(report, updated);

  var sheet = ensureAttendanceTab_(openSpreadsheet_());
  sheet.clear();
  sheet.getRange(1, 1, rows.length, ATTENDANCE_HEADER.length).setValues(rows);
  sheet.setFrozenRows(5);
  return (report.entries || []).length;
}

/**
 * Fetch the year and reduce it to the report both callers want.
 *
 * The whole cost of this feature is here - a login, a dozen chunked event
 * requests, and a profile lookup for everyone who rowed and has since left.
 * Shared by pullAttendance and by the page's uiLoadAttendance so that the tab
 * and the pane can never disagree about who has been to how many.
 */
function buildAttendanceReport_() {
  var snapshot = pullHistory_();
  var entries = attendanceEntries_(snapshot).sort(compareAttendance_);
  return attendanceReport_(snapshot, entries);
}

/**
 * Entry point: count the past year's sessions and write the Attendance tab.
 *
 * The expensive one. It walks the window a chunk at a time and then looks up
 * anyone who rowed but has since left the group, so it is a dozen or more
 * requests where pullGroups is two. Run it when you need the numbers, not on
 * a trigger.
 */
function pullAttendance() {
  var report = buildAttendanceReport_();
  var entries = report.entries;
  var written = writeAttendanceTab_(report);

  console.log('Group: %s', report.groupName);
  console.log('Window: %s (%s days)', report.window, CONFIG.historyDays);
  console.log('Sessions matched: %s', report.sessionCount);

  var above = entries.filter(function (entry) {
    return entry.attended > CONFIG.attendanceThreshold;
  });
  console.log(
    '%s of %s rowers have been to more than %s sessions.',
    above.length,
    entries.length,
    CONFIG.attendanceThreshold
  );
  above.forEach(function (entry) {
    console.log('  %s  %s', entry.attended, entry.name);
  });

  console.log(
    'Wrote %s rows to "%s".',
    written,
    CONFIG.attendanceWorksheetName
  );

  if (!report.sessionCount) {
    console.log(
      'No sessions matched. Run listEventTitles to see what your events are ' +
      'actually called, then fix eventTitleMatches in Config.gs. Note that ' +
      'listEventTitles looks forwards and this looks back, so a title that ' +
      'was changed during the year will match on one and not the other.'
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

/**
 * Entry point: check the counting and the layout against made-up data.
 *
 * Needs no login - every session below is invented. The page's ?page=selftest
 * covers the assignment logic and selfTestLevels covers the group rule; this
 * covers the third thing that is pure and worth pinning down, which is who
 * ends up on the tab and in what order.
 *
 * The cases are the ones that decided the shape: the silent regular, the
 * member who never comes, the guest who does, and where the line falls.
 */
function selfTestAttendance() {
  var passed = 0;
  var failed = 0;

  function check_(condition, what) {
    if (condition) {
      passed += 1;
    } else {
      failed += 1;
      console.log('FAIL  %s', what);
    }
  }

  function session_(id, responses) {
    return {
      id: id,
      heading: 'Monday rowing',
      start: new Date('2026-01-0' + id + 'T16:00:00Z'),
      end: null,
      responses: responses,
    };
  }

  // anna accepts twice; bo declines then accepts; cecilia is invited and never
  // answers; david is waitlisted once, which is an invitation and nothing else.
  var sessions = [
    session_('1', {
      anna: 'accepted',
      bo: 'declined',
      cecilia: 'unanswered',
      david: 'waitinglist',
    }),
    session_('2', { anna: 'accepted', bo: 'accepted', cecilia: 'unanswered' }),
  ];

  var counts = attendanceCounts_(sessions);
  check_(counts.anna.accepted === 2, 'two accepts count as two');
  check_(counts.anna.invited === 2, 'and as two invitations');
  check_(
    counts.bo.accepted === 1 && counts.bo.declined === 1,
    'a decline and an accept are counted apart'
  );
  check_(counts.cecilia.unanswered === 2, 'no answer is counted, not ignored');
  check_(counts.cecilia.accepted === 0, 'and is not an attendance');
  check_(
    counts.david.invited === 1 &&
      counts.david.accepted === 0 &&
      counts.david.declined === 0 &&
      counts.david.unanswered === 0,
    'a waitlisted rower is invited and nothing else - invited is not the sum'
  );

  var snapshot = {
    from: new Date('2025-08-30T00:00:00Z'),
    to: new Date('2026-08-30T00:00:00Z'),
    groupName: 'Test Rodd',
    sessions: sessions,
    rowers: {
      anna: { id: 'anna', firstName: 'Anna', lastName: 'Andersson' },
      bo: { id: 'bo', firstName: 'Bo', lastName: 'Bergman' },
      cecilia: { id: 'cecilia', firstName: 'Cecilia', lastName: 'Carlsson' },
      // In the group, invited to nothing, so absent from `counts` entirely.
      erik: { id: 'erik', firstName: 'Erik', lastName: 'Eriksson' },
      // Gone from the group, but rowed - david is gone and did not.
      david: {
        id: 'david',
        firstName: 'David',
        lastName: 'Dahl',
        formerMember: true,
      },
      frida: {
        id: 'frida',
        firstName: 'Frida',
        lastName: 'Falk',
        formerMember: true,
      },
    },
    groups: {
      blocks: [{ name: 'Grupp 2', members: [{ id: 'anna', name: 'Anna Andersson' }] }],
      unplaced: [],
    },
  };

  var entries = attendanceEntries_(snapshot);
  var byId = {};
  entries.forEach(function (entry) {
    byId[entry.id] = entry;
  });

  check_(!!byId.erik && byId.erik.attended === 0, 'a member who never comes is still listed');
  check_(!byId.david, 'a former member who never rowed is dropped');
  check_(!byId.frida, 'and so is one who was never even invited');
  check_(byId.anna.groups === 'Grupp 2', 'the groups column comes from the blocks');
  check_(byId.cecilia.groups === '', 'a member in no visible group gets an empty one');

  // The same person, still on the tab, once they have actually rowed.
  snapshot.sessions = sessions.concat([
    session_('3', { david: 'accepted' }),
  ]);
  var withGuest = {};
  attendanceEntries_(snapshot).forEach(function (entry) {
    withGuest[entry.id] = entry;
  });
  check_(
    withGuest.david && withGuest.david.attended === 1,
    'a former member who rowed is kept'
  );
  check_(
    withGuest.david.groups === 'no longer in the group',
    'and is labelled in the row rather than in a legend'
  );
  check_(withGuest.david.former === true, 'and flagged, for the pane to mark');
  check_(byId.anna.former === false, 'while a current member is not');

  var sorted = entries.slice().sort(compareAttendance_);
  check_(sorted[0].id === 'anna', 'the most sessions sorts first');
  check_(
    sorted[sorted.length - 1].id === 'erik' ||
      sorted[sorted.length - 2].id === 'erik',
    'and nought sorts last'
  );
  check_(
    compareAttendance_(
      { attended: 3, name: 'Bo Bergman' },
      { attended: 3, name: 'anna andersson' }
    ) > 0,
    'a tie is broken by name, ignoring case'
  );

  // The divider, in terms of the configured threshold rather than a literal
  // ten, so editing Config.gs does not fail a test that is not about it.
  var t = CONFIG.attendanceThreshold;
  var report = attendanceReport_(snapshot, []);
  check_(report.threshold === t, 'the report carries the threshold for the page');
  check_(
    report.sessionCount === snapshot.sessions.length,
    'and the session count, so the page need not hold the sessions'
  );
  check_(
    typeof report.window === 'string' && report.window.indexOf(' to ') !== -1,
    'and the window as text, because a Date does not survive the round trip'
  );

  function report_(rows) {
    return {
      groupName: 'Test Rodd',
      window: 'then to now',
      sessionCount: 2,
      threshold: t,
      entries: rows,
    };
  }

  var ranked = [
    { name: 'Over Two', attended: t + 2, declined: 0, unanswered: 0, invited: 0, groups: '' },
    { name: 'Over One', attended: t + 1, declined: 0, unanswered: 0, invited: 0, groups: '' },
    { name: 'On The Line', attended: t, declined: 0, unanswered: 0, invited: 0, groups: '' },
    { name: 'Under', attended: t - 1, declined: 0, unanswered: 0, invited: 0, groups: '' },
  ];
  var rows = attendanceToRows_(report_(ranked), 'now');
  check_(rows.length === 5 + ranked.length + 1, 'the divider adds one row');
  check_(
    String(rows[7][0]).indexOf('or fewer') !== -1,
    'and falls above the first rower who is not over the line'
  );
  check_(
    rows[6][0] === 'Over One' && rows[8][0] === 'On The Line',
    'with the threshold itself below it - the rule is MORE than ten'
  );

  var allUnder = attendanceToRows_(report_(ranked.slice(2)), 'now');
  check_(
    allUnder.length === 5 + 2,
    'no divider when it would be the very first row'
  );
  var allOver = attendanceToRows_(report_(ranked.slice(0, 2)), 'now');
  check_(allOver.length === 5 + 2, 'and none when nobody is below the line');

  console.log('%s checks passed, %s failed.', passed, failed);
  if (failed) {
    throw new Error(failed + ' attendance checks failed. See the log above.');
  }
}
