/**
 * The rower roster - a port of src/crew_bot/rowers.py.
 *
 * Spond owns *who* is a member. The sheet owns *what level* they are, because
 * Spond has nowhere to put one: no custom field for it, and the one field the
 * group does define is filled in for 1 member of 160. So this tab is the
 * club's own small database, and syncRowers() reconciles the two - it appends
 * anybody new that Spond knows about and never touches a level a coach has
 * already set.
 *
 * The name is the key, for the reasons rowers.py gives. The cost is that two
 * members with exactly the same name share one row, which the sync reports
 * rather than silently merging.
 */

var ROWERS_HEADER = ['Name', 'Level'];

var ROWERS_REQUIRED_COLUMNS = ['name'];

/**
 * Read the tab into {name key: level}, where level is null if blank.
 *
 * An unrecognised level is an error naming the rower and row - the same rule
 * the Class column follows, and for the same reason: a typo would produce a
 * level no boat class can ever match.
 */
function parseRowerRows_(rows, source) {
  source = source || 'Rowers';
  if (!rows || !rows.length) {
    return {};
  }

  var index = headerIndex_(rows[0]);
  var missing = ROWERS_REQUIRED_COLUMNS.filter(function (name) {
    return index[name] === undefined;
  });
  if (missing.length) {
    throw new Error(
      'The "' + source + '" tab is missing the column(s) ' + missing.join(', ') +
      '. Found: ' + (Object.keys(index).join(', ') || '(nothing)') +
      '. Expected: ' + ROWERS_HEADER.join(', ') + '.'
    );
  }

  var levels = {};
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var number = i + 1;

    var name = cellAt_(row, index, 'name');
    if (!name) {
      continue; // blank spacer row
    }

    var rawLevel = cellAt_(row, index, 'level');
    var level = normaliseClass_(rawLevel);
    if (rawLevel && level === null) {
      throw new Error(
        source + ' row ' + number + ': "' + name + '" has level="' + rawLevel +
        '", which is not one of ' + LEVELS.join(', ') + ' (lowest to highest). ' +
        'Fix the cell, or leave it blank until the rower has been graded.'
      );
    }
    levels[nameKey_(name)] = level;
  }

  return levels;
}

/**
 * Fill in each rower's level from the tab, in place on the snapshot.
 *
 * Rowers the tab has never heard of keep level null, which is the same thing
 * a blank cell means: not graded yet, which the assignment reads as the bottom
 * of the scale rather than as unconstrained.
 */
function applyLevels_(snapshot, levels) {
  Object.keys(snapshot.rowers).forEach(function (id) {
    var rower = snapshot.rowers[id];
    var level = levels[nameKey_(fullName_(rower))];
    rower.level = level === undefined ? null : level;
  });
  return snapshot;
}

/**
 * Work out the tab's new contents from its old ones plus Spond's members.
 *
 * Returns {rows, added, duplicates}. Existing rows keep their position and
 * their level: this only ever appends. Nobody is removed either - a member who
 * leaves Spond keeps their row, which is what you want of a database and one
 * line to delete by hand if not.
 */
function syncRowerRows_(rows, memberNames) {
  var existing = rows && rows.length ? rows.slice(1) : [];

  var known = {};
  existing.forEach(function (row) {
    if (row && String(row[0] || '').trim()) {
      known[nameKey_(row[0])] = true;
    }
  });

  var added = [];
  var duplicates = [];
  var seen = {};
  memberNames.forEach(function (name) {
    if (!String(name || '').trim()) {
      return;
    }
    var key = nameKey_(name);
    if (seen[key]) {
      duplicates.push(name);
      return;
    }
    seen[key] = true;
    if (!known[key]) {
      added.push(name);
    }
  });

  // Sorted, so a first run produces an alphabetical tab and later runs add a
  // tidy block at the bottom rather than scattering new names through it.
  added.sort(compareNames_);

  var newRows = [ROWERS_HEADER];
  existing.forEach(function (row) {
    if (row && String(row[0] || '').trim()) {
      var trimmed = row.slice(0, ROWERS_HEADER.length);
      while (trimmed.length < ROWERS_HEADER.length) {
        trimmed.push('');
      }
      newRows.push(trimmed);
    }
  });
  added.forEach(function (name) {
    newRows.push([name, '']);
  });

  return { rows: newRows, added: added, duplicates: duplicates };
}

/** Return the Rowers tab, creating it with just a header if absent. */
function ensureRowersTab_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.rowersWorksheetName);
  if (sheet) {
    return sheet;
  }
  sheet = spreadsheet.insertSheet(CONFIG.rowersWorksheetName);
  sheet.getRange(1, 1, 1, ROWERS_HEADER.length).setValues([ROWERS_HEADER]);
  return sheet;
}

/**
 * Read the Rowers tab.
 *
 * An absent tab is not an error - it just means no levels are set yet, and the
 * payload should still come out usable.
 */
function loadLevels_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.rowersWorksheetName);
  if (!sheet) {
    return {};
  }
  return parseRowerRows_(
    sheet.getDataRange().getValues(),
    CONFIG.rowersWorksheetName
  );
}

/**
 * Entry point: build or update the Rowers tab from Spond's member list.
 *
 * The equivalent of `crew_bot rowers`. Appends only - an existing level is
 * never touched.
 */
function syncRowers() {
  var snapshot = pullSnapshot_();
  var spreadsheet = openSpreadsheet_();
  var sheet = ensureRowersTab_(spreadsheet);

  var memberNames = Object.keys(snapshot.rowers)
    .map(function (id) {
      return fullName_(snapshot.rowers[id]);
    })
    .sort(compareNames_);

  var result = syncRowerRows_(sheet.getDataRange().getValues(), memberNames);

  sheet.clear();
  sheet
    .getRange(1, 1, result.rows.length, ROWERS_HEADER.length)
    .setValues(result.rows);

  console.log(
    '%s rowers in the tab, %s added.',
    result.rows.length - 1,
    result.added.length
  );
  result.added.forEach(function (name) {
    console.log('  + %s', name);
  });

  if (result.duplicates.length) {
    // Reported rather than merged: two people really can share a name, and
    // which row is whose is a question only a coach can answer.
    console.log(
      'Duplicate names in Spond, sharing one row each: %s',
      result.duplicates.join(', ')
    );
  }
}
