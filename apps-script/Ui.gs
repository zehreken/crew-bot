/**
 * The web app: serving the page, and the calls it makes back.
 *
 * Deliberately thin. The page loads once, does all its work in the browser,
 * and calls back only to save - a round trip is several hundred milliseconds,
 * which is fine for a button and would be unbearable in the middle of a drag.
 *
 * That is also why the crew logic is included into the page rather than living
 * in a .gs file: server code is not reachable from client JS, and the seat
 * edits have to run where the pointer is.
 */

/**
 * Pull an HTML partial into a template. Used for the CSS and the JS files.
 *
 * **Do not run this from the editor.** It is called only from the page, as
 * `<?!= include('Styles') ?>`, and it is the first function in this file -
 * which is the one the Run dropdown selects when Ui.gs is the open file. Run
 * it with no argument and createHtmlOutputFromFile throws `Bad value`, the
 * same message it throws for a file that is genuinely missing, from a stack
 * one frame deep. It reads exactly like the page being broken and it is not.
 *
 * It has no trailing underscore because the convention here marks the entry
 * points, and this is one - just not one for a person to press.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** The partials Index.html and SelfTest.html pull in, by the names they use. */
var INCLUDED_FILES = ['Styles', 'CrewsJs', 'AppJs'];

/**
 * Roughly how long each partial is in the repo, for spotting a truncated one.
 *
 * Approximate on purpose - these drift every time the CSS or the page changes,
 * and a stale number here is harmless. It is only ever compared by eye, and
 * the thing it is looking for is a file that arrived half its size.
 */
var INCLUDED_SIZES = { Styles: 10579, CrewsJs: 14543, AppJs: 37362 };

/**
 * Diagnostic: check that every included partial loads.
 *
 * `include` fails as `Exception: Bad value`, which names neither the file nor
 * the reason, and there are two reasons. **The file is not there under that
 * name** - `+ New file -> Script` makes a .gs that include() cannot see, and
 * typing "Styles.html" into the name box makes a file called
 * "Styles.html.html". Or **the file is there and its content will not parse**,
 * which for a file pasted by hand almost always means the paste was cut short
 * and left the `<style>` or `<script>` tag unclosed.
 *
 * So this reports the length as well as the failure. A partial that loads but
 * comes back well under its size in INCLUDED_SIZES is the one to paste again,
 * even though it did not throw - a truncated file that happens to still parse
 * is worse than one that does not, because the page half works.
 */
function checkIncludes() {
  var failed = [];

  INCLUDED_FILES.forEach(function (name) {
    var expected = INCLUDED_SIZES[name] || 0;
    try {
      var length = HtmlService.createHtmlOutputFromFile(name).getContent().length;
      var short = expected && length < expected * 0.9;
      console.log(
        '%s  %-8s %s characters, expected about %s',
        short ? 'SHORT ' : 'ok    ',
        name,
        length,
        expected
      );
    } catch (err) {
      failed.push(name);
      console.log('FAILED  %-8s %s', name, err.message);
    }
  });

  if (!failed.length) {
    console.log('All %s partials load.', INCLUDED_FILES.length);
    return;
  }
  console.log(
    'Check %s in the editor: that it is an HTML file rather than a script, ' +
    'that its name has no ".html" typed on the end, and that its last line ' +
    'closes the tag its first line opens.',
    failed.join(' and ')
  );
}

/**
 * Serve the page.
 *
 * `?page=selftest` runs the crew logic's own checks in the browser instead -
 * the same code the UI drives, in the same environment, which is the whole
 * point of testing it there rather than server-side.
 */
function doGet(e) {
  var page = e && e.parameter && e.parameter.page === 'selftest' ? 'SelfTest' : 'Index';
  return HtmlService.createTemplateFromFile(page)
    .evaluate()
    .setTitle('crew-bot')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Everything the page needs, in one call: Spond, the Boats tab, the levels.
 *
 * One round trip on load, and none until the coach saves.
 */
function uiLoadPayload() {
  return buildFullPayload_();
}

/**
 * Everything the Attendance pane shows, fetched on demand.
 *
 * Deliberately NOT part of uiLoadPayload. That one runs on every page load and
 * has to be quick, because a coach opening the page at the boathouse is there
 * to put people in boats. This is a login, a dozen chunked event requests and
 * a profile lookup for everyone who rowed and has since left - tens of seconds
 * on a phone at the water's edge. Nobody should pay that for statistics they
 * did not ask for, so the pane has its own button and this has its own trip.
 */
function uiLoadAttendance() {
  return buildAttendanceReport_();
}

/**
 * Write the Attendance tab from what the pane is showing.
 *
 * The report goes out to the page and comes straight back, which is the point:
 * the sheet gets exactly what the coach was looking at when they pressed the
 * button, and nobody waits through a second year-long fetch to get it. Same
 * rule uiSaveCrews and uiSaveGroups follow.
 */
function uiSaveAttendance(report) {
  if (!report || !(report.entries || []).length) {
    throw new Error(
      'Nothing to write. Press "Load from Spond" on the Attendance tab first.'
    );
  }

  var written = writeAttendanceTab_(report);
  return (
    'Wrote ' + written + ' rowers to the "' +
    CONFIG.attendanceWorksheetName + '" tab.'
  );
}

/**
 * Lay the crews out for humans to read on the day.
 *
 * One block per boat, then anyone left over. Read by a coach at the boathouse,
 * so it favours short lines over a wide table.
 */
function crewsToRows_(result) {
  var session = result.session || {};
  var rows = [
    [session.heading || 'Crews', session.start || ''],
    ['Generated ' + (result.generated_at || ''), ''],
    ['', ''],
  ];

  (result.crews || []).forEach(function (crew) {
    var rowers = crew.rowers || [];
    // Type and class share the second column: "8+  B". The class is what tells
    // a coach how demanding the hull is, and it is null for unclassed boats.
    var detail = [crew.type || '', crew['class'] || '']
      .filter(function (part) {
        return part;
      })
      .join('  ');
    rows.push([
      crew.boat + '  (' + rowers.length + '/' + crew.seats + ' seats)',
      detail,
    ]);
    rowers.forEach(function (rower, i) {
      rows.push(['  ' + (i + 1) + '. ' + (rower.name || ''), '']);
    });
    rows.push(['', '']);
  });

  // Training on the erg instead. A block like a boat's, after the boats and
  // before the leftovers, and unnumbered because Land has no seats.
  var land = result.land || [];
  if (land.length) {
    rows.push(['Land (' + land.length + ')', '']);
    land.forEach(function (rower) {
      rows.push(['  ' + (rower.name || ''), '']);
    });
    rows.push(['', '']);
  }

  var leftover = result.unassigned || [];
  if (leftover.length) {
    rows.push(['Not assigned (' + leftover.length + ')', '']);
    leftover.forEach(function (rower) {
      rows.push(['  ' + (rower.name || ''), '']);
    });
  }

  return rows;
}

/**
 * Write the crews to a tab named after the session date, e.g. "2026-08-20".
 *
 * Replaced wholesale, so re-running after a late cancellation produces the
 * corrected list rather than a second copy.
 *
 * Returns a message for the page's status line.
 */
function uiSaveCrews(result) {
  var spreadsheet = openSpreadsheet_();
  var session = result.session || {};
  var title = session.date || Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd');

  var sheet = spreadsheet.getSheetByName(title);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(title);
  }

  var rows = crewsToRows_(result);
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);

  var seated = 0;
  (result.crews || []).forEach(function (crew) {
    seated += (crew.rowers || []).length;
  });

  var landed = (result.land || []).length;
  return (
    'Wrote ' + (result.crews || []).length + ' boats, ' + seated +
    ' rowers' + (landed ? ' and ' + landed + ' on land' : '') +
    ' to the "' + title + '" tab.'
  );
}

/**
 * Write the Groups tab from what the page is showing.
 *
 * The same tab pullGroups writes, by the same function - the difference is
 * only where the data came from. The page already has it from the load, so
 * this writes rather than re-fetches, exactly as uiSaveCrews does. Pressing
 * Reload from Spond first is how you get a fresher one.
 *
 * `blocks` arrives as [{name, members: [{id, name}]}] straight from the
 * payload, and `unplaced` the same shape.
 */
function uiSaveGroups(blocks, unplaced) {
  blocks = blocks || [];
  unplaced = unplaced || [];
  if (!blocks.length && !unplaced.length) {
    throw new Error(
      'No groups to write. Press "Reload from Spond" first - if the club ' +
      'really has no subgroups, there is nothing for this tab to hold.'
    );
  }

  writeGroupsTab_(blocks, unplaced);

  var placed = placedCount_(blocks);
  return (
    'Wrote ' + blocks.length + ' groups and ' + (placed + unplaced.length) +
    ' members to the "' + CONFIG.groupsWorksheetName + '" tab.'
  );
}
