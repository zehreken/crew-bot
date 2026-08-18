/**
 * The shared vocabulary - a port of the parts of src/crew_bot/models.py that
 * this side needs.
 *
 * Nothing here knows about Spond or about spreadsheets. The boat classes and
 * the rower levels are deliberately the same scale, because a level exists to
 * say which class of boat someone can be trusted with: that makes the whole
 * eligibility question the comparison "level >= class" rather than a table
 * mapping one set of letters onto another.
 *
 * The letters live here and nowhere else. If the club ever adds a class, this
 * is the single place it goes.
 */

// Lowest first: C is the stable trainer, AA the racing shell.
var BOAT_CLASSES = ['C', 'B', 'A', 'AA'];

// Rower levels are the same scale, not a parallel one. See above.
var LEVELS = BOAT_CLASSES;

/**
 * Tidy a Class or Level cell into one of BOAT_CLASSES, or null if it is not
 * one.
 *
 * Case and surrounding whitespace are noise a coach should not have to think
 * about; anything else is a typo the caller must complain about loudly rather
 * than quietly drop, because a value outside the scale would silently match
 * no boat and no rower.
 */
function normaliseClass_(value) {
  var candidate = String(value || '').trim().toUpperCase();
  return BOAT_CLASSES.indexOf(candidate) !== -1 ? candidate : null;
}

/**
 * 1-based position on the scale: C -> 1, B -> 2, A -> 3, AA -> 4.
 *
 * 1-based so that 0 is free to mean "unclassed" once this reaches the
 * assignment code, where an absent value wants to be a plain number rather
 * than a null.
 */
function classRank_(boatClass) {
  if (boatClass === null || boatClass === undefined) {
    return null;
  }
  var index = BOAT_CLASSES.indexOf(boatClass);
  return index === -1 ? null : index + 1;
}

/**
 * Compare two names the way Python's sorted() does - by code point.
 *
 * Deliberately NOT localeCompare. Python sorts "Åsa" after "Zetterberg";
 * localeCompare may not, and while both orders are defensible, only one of
 * them lets the sheet this produces be diffed against the sheet the Python
 * produces. Parity is worth more than collation while both exist.
 */
function compareNames_(a, b) {
  var left = String(a || '');
  var right = String(b || '');
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * The first run of digits in a string: "2x/2-" -> 2, "85 kg" -> 85.
 *
 * First run, not every digit: "2x/2-" is a double, and concatenating the
 * digits would make it a 22-seater. Returns null when there are none.
 */
function leadingNumber_(text) {
  var match = String(text || '').match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Map a tab's header row to column indexes, lower-cased and trimmed.
 *
 * Columns may be in any order and optional ones may be missing entirely -
 * this reads the club's existing tabs rather than imposing a layout on them.
 */
function headerIndex_(headerRow) {
  var index = {};
  for (var i = 0; i < headerRow.length; i++) {
    var name = String(headerRow[i] || '').trim().toLowerCase();
    // First occurrence wins, matching header.index(name) in the Python.
    if (name && index[name] === undefined) {
      index[name] = i;
    }
  }
  return index;
}

/** One trimmed cell by column name, or "" if the column or value is absent. */
function cellAt_(row, index, name) {
  var at = index[name];
  if (at === undefined || at >= row.length) {
    return '';
  }
  return String(row[at] === null || row[at] === undefined ? '' : row[at]).trim();
}

/**
 * Match names the way a person would: ignoring case and extra spaces.
 *
 * This is the key the Rowers tab is joined on. The name is the key because a
 * coach maintains that tab by hand and a 28-character Spond id is not
 * something anyone can check by eye.
 */
function nameKey_(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(function (part) {
      return part !== '';
    })
    .join(' ')
    .toLowerCase();
}
