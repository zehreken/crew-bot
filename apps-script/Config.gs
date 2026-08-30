/**
 * Settings and secrets, the Apps Script side.
 *
 * Every setting there is. They live in a .gs file rather than a config file
 * because Apps Script has no filesystem to read one from - there is nowhere
 * else to put them.
 *
 * Secrets are NOT here and must never be. They live in Script Properties
 * (Project Settings -> Script Properties), which are part of the deployment
 * rather than the source, so this file stays safe to commit and to push with
 * clasp. Only someone with edit access to the script project can read them,
 * which is why the project is standalone rather than bound to the sheet.
 */

var CONFIG = {
  // The Spond group to pull from, exactly as it is named in the app.
  // Run `listGroups` if you are not sure of the spelling.
  groupName: 'Hammarby Rodd',

  // Which boats each of the club's groups may take. A rower's level is the
  // BEST class among the groups they are in - see Levels.gs, which is where
  // the rule and its edge cases are written out.
  //
  // Grupp 0 is listed with null on purpose: no water experience, no boat, not
  // even an unclassed one. Null is off the scale, not the bottom of it.
  //
  // Magelungen and Hammarby Herråtta are missing on purpose too. They say
  // where somebody rows, not how well, so they must not put anyone in a boat.
  // A group not listed here contributes nothing, and a rower in no listed
  // group at all counts as C.
  //
  // Spelling is matched ignoring case and extra spaces. If a group is renamed
  // in Spond - "Hammarby Herråtta 2027" - rename it here too; run pullGroups
  // to see the names exactly as Spond has them.
  groupLevels: {
    'Grupp 0': null,
    'Grupp 1': 'C',
    'Grupp 1a': 'C',
    'Grupp 2': 'B',
    'Grupp 3': 'A',
    'Grupp 4': 'AA',
  },

  // An event matches if ANY of these appears in its title, case-insensitively
  // and ignoring extra whitespace. Deliberately an explicit list rather than a
  // loose "rowing" match, which would also pull in anything else with the word
  // in its title - regattas, ergo sessions, the club dinner. Add a line when a
  // new open session starts running.
  eventTitleMatches: ['monday rowing', 'thursday rowing', 'saturday rowing'],

  // How many days ahead to look, and a safety cap on one request.
  lookaheadDays: 14,
  maxEvents: 100,

  // How far BACK the Attendance tab counts, and how wide each request into
  // that window is. See spondEventsBetween_ in Spond.gs for why the window is
  // walked in chunks rather than asked for in one go; the short version is
  // that `sponds/` has a `max` and no paging, so one request for a whole year
  // would return a truncated answer and no error.
  //
  // A rolling year rather than a season with a start date: nobody has to
  // remember to edit it each spring, and a year always contains a whole
  // season. The cost is that the window slides, so a rower's count drifts
  // down as old sessions fall off the back of it.
  historyDays: 365,
  historyChunkDays: 30,

  // The tab counting how many sessions each rower has signed up for, written
  // next to Groups. Created if it does not exist.
  attendanceWorksheetName: 'Attendance',

  // The line the Attendance tab draws itself at. Rowers with MORE than this
  // many sessions are listed above it - that is the cleaning-crew rule, "more
  // than ten", so ten itself falls below.
  attendanceThreshold: 10,

  // The tab holding the boat inventory: type, weight, name, producer, class,
  // available, notes. Created with example rows if it does not exist.
  boatsWorksheetName: 'Boats',

  // The tab listing each Spond subgroup with its members underneath. Unlike
  // Boats this one is an output: pullGroups rebuilds it from Spond wholesale,
  // so nothing typed into it survives. It is also the roster now that the
  // Rowers tab is gone - every member of the club appears in it exactly once
  // per group they are in.
  groupsWorksheetName: 'Groups',

  // Everything downstream is read by humans in Stockholm, so the dates and
  // times written to the sheet are local ones. Said out loud here rather than
  // left to the machine's zone, which is what the Python's bare .astimezone()
  // depends on. Keep it in step with timeZone in appsscript.json.
  timeZone: 'Europe/Stockholm',
};

/**
 * Read a Script Property, failing with the exact key that is missing.
 *
 * A missing property is the first thing anyone setting this up will hit, so
 * the message names what to add and where, rather than surfacing as a null
 * somewhere deep in the Spond login.
 */
function scriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(
      'Missing Script Property "' + key + '". Add it under ' +
      'Project Settings -> Script Properties.'
    );
  }
  return value;
}

/** The spreadsheet to write to, opened by id rather than by name.
 *
 * By id because this script is standalone: it is not attached to the sheet,
 * which is what keeps the Spond password out of reach of anyone who has edit
 * access to the spreadsheet. The id is the long string in the sheet's URL,
 * between /d/ and /edit.
 */
function openSpreadsheet_() {
  return SpreadsheetApp.openById(scriptProperty_('SPREADSHEET_ID'));
}
