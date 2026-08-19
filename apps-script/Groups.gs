/**
 * The Groups tab - a port of the subgroup half of src/crew_bot/spond_client.py
 * and sheets.py (`_subgroup_blocks`, `groups_to_rows`, `write_groups`).
 *
 * Who is in which of the club's groups - Grupp 0 to Grupp 4, Magelungen,
 * Hammarby Herråtta - read straight out of Spond and written to a tab next to
 * Boats. Since the Rowers tab was retired this is also the club's roster: the
 * groups between them hold every member.
 *
 * Note the two meanings of "group" that meet here. Spond's *group* is the club
 * itself, the one thing CONFIG.groupName names and `listGroups` lists. What a
 * coach calls a group is a Spond *subgroup*, and that is what this tab holds.
 * The entry point is `pullGroups` rather than `listGroups`, which was taken.
 *
 * Unlike Boats, which sits next to it and is typed into by hand, this tab is
 * an output: every cell comes from Spond and every run replaces the lot. That
 * is the point - it is how a group change made in the Spond app shows up in
 * the sheet, and since a group now decides what a rower may row (Levels.gs),
 * it is also the record of why anyone got the boat they got.
 */

/**
 * Compare names ignoring case, then by code point.
 *
 * The Python sorts these lists with key=str.lower, so matching it is what lets
 * the two tabs be diffed while both implementations exist - the same reason
 * compareNames_ exists at all. (toLowerCase and Python's .lower() can disagree
 * on exotic scripts; for Swedish names they do not.)
 */
function compareNamesIgnoringCase_(a, b) {
  return compareNames_(
    String(a || '').toLowerCase(),
    String(b || '').toLowerCase()
  );
}

/** Order two {id, name} members the way the lists above are ordered. */
function compareMembers_(a, b) {
  return compareNamesIgnoringCase_(a.name, b.name);
}

/**
 * Split a group payload into {blocks, unplaced}.
 *
 * `blocks` is [{name, members}] - one per subgroup. `unplaced` is everyone who
 * ended up in none of them. A member is {id, name}, not a bare name: the sheet
 * only ever needs the name, but the page joins these against the roster to
 * show a level, and joining on a Spond id cannot be wrong the way joining on a
 * name can. (The Python's _subgroup_blocks returns plain strings, having no UI
 * to serve. The tab both produce is identical, which is the part that matters.)
 *
 * Pure, like rowersFromGroup_, so the ordering and the unplaced rule can be
 * checked without a login.
 *
 * Subgroups come back sorted by name, not in Spond's own order. Spond returns
 * them in the order they were created - for this club that puts "Grupp 1a"
 * last, after "Magelungen", which reads as a bug to anyone scrolling the tab.
 * Sorting also matches what the Python's `subgroups` command prints.
 *
 * A subgroup with no members is kept, as an empty block: it means someone made
 * the group and has not filled it in, which is worth seeing. Dropping it would
 * look exactly like the group not existing.
 */
function subgroupBlocks_(group) {
  var subGroups = group.subGroups || [];

  var members = {};
  subGroups.forEach(function (sub) {
    members[sub.id] = [];
  });

  var unplaced = [];
  (group.members || []).forEach(function (member) {
    var entry = {
      id: member.id || '',
      name: fullName_({
        id: member.id || '',
        firstName: member.firstName || '',
        lastName: member.lastName || '',
      }),
    };

    // An id with no matching subgroup means a subgroup this login cannot see.
    // Such a member counts as unplaced - but only if none of their subgroups
    // is visible, or they would be listed twice.
    var placed = (member.subGroups || []).filter(function (id) {
      return members[id] !== undefined;
    });
    placed.forEach(function (id) {
      members[id].push(entry);
    });
    if (!placed.length) {
      unplaced.push(entry);
    }
  });

  var blocks = subGroups.map(function (sub) {
    return {
      name: sub.name || '?',
      members: members[sub.id].sort(compareMembers_),
    };
  });
  blocks.sort(function (a, b) {
    return compareNamesIgnoringCase_(a.name, b.name);
  });

  // Not deduplicated: two members really can share a name, and losing one of
  // them is worse than showing the name twice. Harmless here, because
  // everything downstream joins on the Spond id rather than on the name.
  return { blocks: blocks, unplaced: unplaced.sort(compareMembers_) };
}

/** "1 member" / "7 members", the same wording the Python prints. */
function memberCount_(count) {
  return count + ' member' + (count === 1 ? '' : 's');
}

/**
 * Lay the subgroups out as one block per group, members beneath.
 *
 * Same shape as crewsToRows_, and for the same reason: this is read down a
 * phone screen, so it is a list with headings rather than a wide table.
 *
 * The banner says out loud that the tab is rebuilt from Spond. Boats and
 * Rowers sit next to it and are the opposite, and without the line there is
 * nothing to tell them apart on screen.
 *
 * Names repeat: Spond lets a rower sit in several subgroups at once and the
 * club uses that (Grupp 3 and Hammarby Herråtta 2026 overlap heavily). A
 * reader must not take the blocks for a partition, hence the second line.
 */
function groupsToRows_(groupName, blocks, unplaced, updated) {
  var rows = [
    ['Groups in ' + groupName, updated ? 'Updated ' + updated : ''],
    ['Rebuilt from Spond each run; a rower can be in several groups.', ''],
    ['', ''],
  ];

  blocks.forEach(function (block) {
    rows.push([block.name, memberCount_(block.members.length)]);
    block.members.forEach(function (member) {
      rows.push(['  ' + member.name, '']);
    });
    rows.push(['', '']);
  });

  if (unplaced.length) {
    // Last, and named rather than implied: a member in no group is the one
    // thing on this tab that is a to-do rather than a fact.
    rows.push(['Not in any group', memberCount_(unplaced.length)]);
    unplaced.forEach(function (member) {
      rows.push(['  ' + member.name, '']);
    });
  }

  return rows;
}

/**
 * Return the Groups tab, creating it just after Boats if it is absent.
 *
 * Next to Boats because those two are now the whole input side of the sheet -
 * the hulls and the people - and insertSheet with no index appends at the far
 * right, past the dated crew tabs. An existing tab is never moved: by then a
 * coach has put it where they want it. (It used to be anchored to Rowers,
 * which no longer exists.)
 *
 * getIndex() is 1-based and insertSheet's index is 0-based, so passing the one
 * straight to the other lands immediately after.
 */
function ensureGroupsTab_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(CONFIG.groupsWorksheetName);
  if (sheet) {
    return sheet;
  }
  var boats = spreadsheet.getSheetByName(CONFIG.boatsWorksheetName);
  if (boats) {
    return spreadsheet.insertSheet(CONFIG.groupsWorksheetName, boats.getIndex());
  }
  return spreadsheet.insertSheet(CONFIG.groupsWorksheetName);
}

/**
 * Replace the Groups tab with these blocks. Returns the number of rows.
 *
 * Shared by the two ways in: pullGroups from the editor, which fetches first,
 * and uiSaveGroups from the page, which writes what the coach is looking at.
 * Neither re-reads the tab, because nothing on it is anyone's to keep.
 */
function writeGroupsTab_(blocks, unplaced) {
  var updated = Utilities.formatDate(
    new Date(),
    CONFIG.timeZone,
    'yyyy-MM-dd HH:mm'
  );

  // CONFIG.groupName rather than the group's own name, which findGroup_
  // matched only case-insensitively. The Python writes the configured spelling
  // into this cell too, and the two tabs being diffable is worth more than
  // preferring Spond's capitalisation on one side only.
  var rows = groupsToRows_(CONFIG.groupName, blocks, unplaced, updated);

  var sheet = ensureGroupsTab_(openSpreadsheet_());
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  return rows.length;
}

/**
 * How many distinct people the blocks cover.
 *
 * By id, not by name: a rower can sit in several groups at once, so the block
 * sizes deliberately do not add up to the roster, and two members really can
 * share a name.
 */
function placedCount_(blocks) {
  var seen = {};
  blocks.forEach(function (block) {
    block.members.forEach(function (member) {
      seen[member.id] = true;
    });
  });
  return Object.keys(seen).length;
}

/**
 * Entry point: pull the club's subgroups from Spond and write the Groups tab.
 *
 * The equivalent of `crew_bot groups-tab`. Cheaper than pullAttendance: the
 * subgroups arrive inside the group payload, so this is one login and one GET,
 * with no event fetch and no profile lookups.
 *
 * The page has its own route to the same tab - the Groups pane's "Write to
 * sheet" button, via uiSaveGroups - so this is the developer's copy, for
 * checking the setup from the editor before anything is deployed.
 */
function pullGroups() {
  var token = spondLogin_();
  var groups = spondGet_('groups/', token) || [];
  if (!groups.length) {
    throw new Error('Spond returned no groups for this login.');
  }
  var group = findGroup_(groups, CONFIG.groupName);

  var split = subgroupBlocks_(group);
  var blocks = split.blocks;
  var unplaced = split.unplaced;

  if (!blocks.length && !unplaced.length) {
    console.log('"%s" has no subgroups and no members.', CONFIG.groupName);
    return 0;
  }

  var written = writeGroupsTab_(blocks, unplaced);

  console.log(
    'Wrote %s group(s) and %s rows to "%s".',
    blocks.length,
    written,
    CONFIG.groupsWorksheetName
  );
  blocks.forEach(function (block) {
    console.log('  %s  %s', block.name, memberCount_(block.members.length));
  });

  // A rower can sit in several groups, so the block sizes deliberately do not
  // add up to the roster. Say the roster size too, or the sum looks wrong.
  var placed = placedCount_(blocks);
  console.log('%s of %s members are in a group.', placed, placed + unplaced.length);
  if (unplaced.length) {
    console.log('%s are in none - they are listed at the bottom.', unplaced.length);
  }
  return written;
}
