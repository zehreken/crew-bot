/**
 * A rower's level, worked out from which of the club's groups they are in.
 *
 * This replaces the Rowers tab, which used to be the only place a level
 * existed: a hand-kept column of letters a coach had to remember to update.
 * The club already sorts its rowers into groups in Spond, and already keeps
 * those current because that is how sessions get invited - so the letters were
 * a second copy of the same judgement, kept worse. They are gone. The group is
 * the judgement.
 *
 * The rule is one line: **a rower's level is the best class among the groups
 * they are in.** Best, not only, because plenty of people are in more than one
 * and the three leaders are in all of them; taking the maximum is the only
 * reading under which a leader is not demoted by also being in Grupp 0.
 *
 * Three things the mapping in Config.gs cannot say on its own:
 *
 *   **Grupp 0 is listed with no level at all.** It is not the bottom of the
 *   scale, it is off the scale. No water experience means no boat - not even
 *   an unclassed one. That last part is enforced in mayRow_ in CrewsJs.html,
 *   because an unclassed hull otherwise constrains nobody.
 *
 *   **Magelungen and Hammarby Herråtta are deliberately absent** from the
 *   mapping. They say where somebody rows, not how well, so they contribute
 *   nothing to the maximum and adding them would be a category error.
 *
 *   **A rower in none of the mapped groups counts as C.** Only Magelungen,
 *   say, or in no group this login can see. That is the old ungraded rule,
 *   kept for the one case it still fits: nobody should be stuck on the dock
 *   over a gap in Spond bookkeeping, and C is the stable trainer. Grupp 0 is
 *   treated differently because it is not a gap - somebody put them there.
 */

/** What a rower in no mapped group gets. See the third note above. */
var UNGROUPED_LEVEL = 'C';

/**
 * CONFIG.groupLevels, keyed by nameKey_ so that "Grupp 1A", "grupp 1a" and
 * "Grupp  1a" all find the same row - these names are typed into Spond by a
 * person, and matching them exactly would break on a stray capital.
 *
 * Built lazily rather than at load: Apps Script does not promise that Config.gs
 * has run its top level before this file has.
 */
var GROUP_LEVELS_ = null;

function groupLevels_() {
  if (GROUP_LEVELS_) {
    return GROUP_LEVELS_;
  }

  var map = {};
  Object.keys(CONFIG.groupLevels).forEach(function (name) {
    var level = CONFIG.groupLevels[name];
    // Loudly, the same rule the Class column follows: a typo here would hand a
    // whole group the ungrouped default and look exactly like it had worked.
    if (level !== null && BOAT_CLASSES.indexOf(level) === -1) {
      throw new Error(
        'CONFIG.groupLevels has "' + name + '": "' + level + '", which is not ' +
        'one of ' + BOAT_CLASSES.join(', ') + ' (lowest to highest), and not ' +
        'null. Use null for a group whose members take no boat at all.'
      );
    }
    map[nameKey_(name)] = level;
  });

  GROUP_LEVELS_ = map;
  return map;
}

/**
 * The best class among these group names, or null for no boat at all.
 *
 * Pure, so the rule can be checked without a login - which is what
 * selfTestLevels does. A group the mapping has never heard of is skipped
 * rather than treated as an error: Spond groups come and go, and a new one
 * appearing should not stop the session being assigned.
 */
function levelFromGroups_(groupNames) {
  var map = groupLevels_();

  var best = null;
  // -1 rather than 0, because 0 is Grupp 0's own rank: "in Grupp 0" has to
  // stay distinguishable from "in nothing the mapping knows about", and those
  // two cases have opposite answers.
  var bestRank = -1;

  (groupNames || []).forEach(function (name) {
    var key = nameKey_(name);
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      return;
    }
    var level = map[key];
    var rank = level === null ? 0 : classRank_(level);
    if (rank > bestRank) {
      bestRank = rank;
      best = level;
    }
  });

  return bestRank < 0 ? UNGROUPED_LEVEL : best;
}

/**
 * Fill in every rower's level from the group blocks, in place on the snapshot.
 *
 * The replacement for applyLevels_ in the deleted Rowers.gs, and cheaper: it
 * reads snapshot.groups, which pullSnapshot_ has already worked out from the
 * group payload, so no request and no sheet read.
 *
 * A subgroup this login cannot see is not in the blocks and so cannot
 * contribute. That is the same limitation the Groups tab has and has the same
 * fix - log in as someone who can see it - but it is worth knowing that the
 * failure mode is a silent demotion to C rather than an error.
 */
function applyGroupLevels_(snapshot) {
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

  Object.keys(snapshot.rowers).forEach(function (id) {
    snapshot.rowers[id].level = levelFromGroups_(memberships[id] || []);
  });
  return snapshot;
}

/**
 * Entry point: check the rule against the cases that decided its shape.
 *
 * The page's ?page=selftest covers the assignment logic, but not this: the
 * group names come from Spond, so the rule lives server-side where that page
 * cannot reach it. Needs no login - every case here is made up. What the real
 * club comes out as is logPayload's job.
 */
function selfTestLevels() {
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

  check_(levelFromGroups_(['Grupp 1']) === 'C', 'Grupp 1 is C');
  check_(levelFromGroups_(['Grupp 1a']) === 'C', 'Grupp 1a is C too');
  check_(levelFromGroups_(['Grupp 2']) === 'B', 'Grupp 2 is B');
  check_(levelFromGroups_(['Grupp 3']) === 'A', 'Grupp 3 is A');
  check_(levelFromGroups_(['Grupp 4']) === 'AA', 'Grupp 4 is AA');
  check_(levelFromGroups_(['Grupp 0']) === null, 'Grupp 0 is no boat at all');

  check_(
    levelFromGroups_(['Grupp 0', 'Grupp 1', 'Grupp 2', 'Grupp 3', 'Grupp 4']) === 'AA',
    'a leader in every group is AA, not Grupp 0'
  );
  check_(
    levelFromGroups_(['Grupp 4', 'Grupp 1']) === 'AA',
    'and the order the groups arrive in does not matter'
  );
  check_(
    levelFromGroups_(['Grupp 0', 'Grupp 2']) === 'B',
    'Grupp 0 never drags anyone down - the best group wins'
  );

  check_(
    levelFromGroups_(['Magelungen']) === UNGROUPED_LEVEL,
    'a group that says where rather than how well contributes nothing'
  );
  check_(
    levelFromGroups_(['Hammarby Herråtta 2026', 'Grupp 0']) === null,
    'and it does not rescue a Grupp 0 rower either'
  );
  check_(levelFromGroups_([]) === UNGROUPED_LEVEL, 'no groups at all counts as C');

  check_(levelFromGroups_(['grupp  2']) === 'B', 'case and extra spaces are noise');
  check_(levelFromGroups_(['Grupp 5']) === UNGROUPED_LEVEL, 'an unknown group is skipped, not an error');

  console.log('%s checks passed, %s failed.', passed, failed);
  if (failed) {
    throw new Error(failed + ' level checks failed. See the log above.');
  }
}
