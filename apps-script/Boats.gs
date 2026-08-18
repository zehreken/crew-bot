/**
 * The boat inventory - a port of src/crew_bot/boats.py.
 *
 * The sheet is the source of truth: coaches already work there, and boats
 * change (damage, loans, new purchases) far more often than the code does.
 *
 * This reads the club's existing vocabulary rather than imposing one: a `type`
 * column in rowing shorthand ("1x", "2x/2-", "8+") with the seat count inside
 * it, a crew `weight` in kg, and a `class` from the C/B/A/AA scale.
 */

// Matches the club's own boat list, so a tab this code creates and the real
// one look the same. Reading is case-insensitive and order-independent, so
// neither the capitals nor the order here are load-bearing.
var BOATS_HEADER = [
  'Type',
  'Weight',
  'Name',
  'Producer',
  'Class',
  'Available',
  'Notes',
];

// Written into a freshly created tab so the format is self-explanatory.
var BOATS_EXAMPLE_ROWS = [
  ['8+', '85 kg', 'Example eight', 'Stampfli', 'B', 'yes', 'delete this row'],
  ['4x/4-', '75 kg', 'Example four', 'Filippi', 'A', 'yes', 'delete this row'],
  ['1x', '70 kg', 'Example single', 'Wintech', 'AA', 'no', 'delete this row'],
];

// Only these have to be present; everything else reads as blank if absent.
var BOATS_REQUIRED_COLUMNS = ['name', 'type'];

// Types with no digit in them. Small and explicit rather than a guess, so a
// genuinely unrecognised type is an error a coach can see and fix.
var TYPE_SEATS = {
  trimmer: 1,
};

var NOT_AVAILABLE = ['no', 'false', '0', 'n', 'nej'];

/**
 * Seats in a boat of this type, or null if the type is unrecognised.
 *
 * The number in the type is the crew size: "8+" is eight rowers (the cox is
 * not a seat we fill), "4x/4-" is four whether it is rigged for sculling or
 * sweep, "C1x" is a coastal single.
 */
function seatsForType_(boatType) {
  var normalised = String(boatType || '').trim().toLowerCase();
  if (!normalised) {
    return null;
  }
  var seats = leadingNumber_(normalised);
  if (seats !== null) {
    return seats;
  }
  return TYPE_SEATS[normalised] === undefined ? null : TYPE_SEATS[normalised];
}

/** Blank counts as available - a full column of "yes" is busywork. */
function boatAvailable_(value) {
  return NOT_AVAILABLE.indexOf(String(value || '').trim().toLowerCase()) === -1;
}

/**
 * Turn the tab's raw cell values into boats.
 *
 * Tolerant of how humans actually fill in spreadsheets: blank rows, extra
 * whitespace, columns in any order, optional columns missing entirely, yes/no
 * in any casing. `source` only names the tab in error messages.
 */
function parseBoatRows_(rows, source) {
  source = source || 'Boats';
  if (!rows || !rows.length) {
    return [];
  }

  var index = headerIndex_(rows[0]);
  var missing = BOATS_REQUIRED_COLUMNS.filter(function (name) {
    return index[name] === undefined;
  });
  if (missing.length) {
    throw new Error(
      'The "' + source + '" tab is missing the column(s) ' + missing.join(', ') +
      '. Found: ' + (Object.keys(index).join(', ') || '(nothing)') +
      '. Expected something like: ' + BOATS_HEADER.join(', ') + '.'
    );
  }

  var boats = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var number = i + 1; // 1-based, counting the header, as the Python does

    var name = cellAt_(row, index, 'name');
    if (!name) {
      continue; // blank spacer row
    }

    var boatType = cellAt_(row, index, 'type');
    var seats = seatsForType_(boatType);
    if (seats === null) {
      throw new Error(
        source + ' row ' + number + ': boat "' + name + '" has type="' +
        boatType + '", which has no crew size in it. Use the rowing shorthand ' +
        '(1x, 2x, 2x/2-, 4x/4-, 4++, 8+), or add it to TYPE_SEATS in Boats.gs ' +
        'if it is a named boat like Trimmer.'
      );
    }

    // 0 in the weight column means the tab does not rate this hull, which is
    // not the same as a boat built for a 0 kg crew.
    var weight = leadingNumber_(cellAt_(row, index, 'weight'));
    var weightKg = weight ? weight : null;

    // Blank is a boat nobody has classed yet, which is fine. A non-blank cell
    // that is not one of the four is a typo, and letting it through would put
    // a boat in a class that silently matches no rower.
    var rawClass = cellAt_(row, index, 'class');
    var boatClass = normaliseClass_(rawClass);
    if (rawClass && boatClass === null) {
      throw new Error(
        source + ' row ' + number + ': boat "' + name + '" has class="' +
        rawClass + '", which is not one of ' + BOAT_CLASSES.join(', ') +
        ' (lowest to highest). Fix the cell, or leave it blank if the boat has ' +
        'not been classed yet.'
      );
    }

    boats.push({
      name: name,
      type: boatType,
      seats: seats,
      weightKg: weightKg,
      boatClass: boatClass,
      producer: cellAt_(row, index, 'producer'),
      available: boatAvailable_(cellAt_(row, index, 'available')),
    });
  }

  return boats;
}

/**
 * Return the Boats tab, creating and seeding it if absent.
 *
 * Returns {sheet, created} so the caller can tell the coach to go and fill it
 * in rather than silently handing back an empty inventory.
 */
function ensureBoatsTab_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.boatsWorksheetName);
  if (sheet) {
    return { sheet: sheet, created: false };
  }
  sheet = spreadsheet.insertSheet(CONFIG.boatsWorksheetName);
  var rows = [BOATS_HEADER].concat(BOATS_EXAMPLE_ROWS);
  sheet.getRange(1, 1, rows.length, BOATS_HEADER.length).setValues(rows);
  return { sheet: sheet, created: true };
}

/** Read the Boats tab, with the same refusals the Python makes. */
function loadBoats_(spreadsheet) {
  var found = ensureBoatsTab_(spreadsheet);
  if (found.created) {
    throw new Error(
      'Created a "' + CONFIG.boatsWorksheetName + '" tab with example rows. ' +
      'Fill in your real boats there, then run this again.'
    );
  }
  var boats = parseBoatRows_(
    found.sheet.getDataRange().getValues(),
    CONFIG.boatsWorksheetName
  );
  if (!boats.length) {
    throw new Error(
      'The "' + CONFIG.boatsWorksheetName + '" tab has no boats in it yet. ' +
      'Add one row per boat: at least a type and a name.'
    );
  }
  return boats;
}

/**
 * Entry point: list the boat inventory, the equivalent of `crew_bot boats`.
 *
 * Prints unclassed boats as "-" and counts them, so it is easy to see what is
 * still left to fill in.
 */
function listBoats() {
  var boats = loadBoats_(openSpreadsheet_());

  var unclassed = 0;
  var unavailable = 0;
  boats.forEach(function (boat) {
    if (boat.boatClass === null) {
      unclassed += 1;
    }
    if (!boat.available) {
      unavailable += 1;
    }
    console.log(
      '  %s  %s  %s seats  class %s  %s',
      boat.name,
      boat.type,
      boat.seats,
      boat.boatClass === null ? '-' : boat.boatClass,
      boat.available ? '' : '(unavailable)'
    );
  });

  console.log(
    '%s boats, %s unclassed, %s unavailable.',
    boats.length,
    unclassed,
    unavailable
  );
}
