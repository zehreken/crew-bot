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

/** Pull an HTML partial into a template. Used for the CSS and the JS files. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
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
 * Lay the crews out for humans to read on the day - a port of crews_to_rows
 * in sheets.py.
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

  return (
    'Wrote ' + (result.crews || []).length + ' boats and ' + seated +
    ' rowers to the "' + title + '" tab.'
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
