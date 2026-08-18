/**
 * Settings and secrets, the Apps Script side.
 *
 * The settings below are the same ones config.toml holds for the Python half.
 * They are duplicated rather than shared because Apps Script cannot read the
 * repo - there is no TOML parser and no filesystem. Keep the two in step by
 * hand until one side or the other stops being used.
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

  // An event matches if ANY of these appears in its title, case-insensitively
  // and ignoring extra whitespace. An explicit list, not a loose "rowing"
  // match, for the reasons config.toml gives. Add a line when a new open
  // session starts running.
  eventTitleMatches: ['monday rowing', 'thursday rowing', 'saturday rowing'],

  // How many days ahead to look, and a safety cap on one request.
  lookaheadDays: 14,
  maxEvents: 100,

  // The tab to write attendance into. Created if it does not exist.
  worksheetName: 'Attendance',

  // The tab holding the boat inventory: type, weight, name, producer, class,
  // available, notes. Created with example rows if it does not exist.
  boatsWorksheetName: 'Boats',

  // The tab holding the rower roster: name, level. This is the club's own
  // small database - Spond has no field for a rower's level, so it lives here.
  rowersWorksheetName: 'Rowers',

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
