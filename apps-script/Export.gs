/**
 * The payload the crew assigner reads.
 *
 * This used to be a file. The Python wrote data/attendance.json and handed it
 * to a separate C++ program; here the assigner is JS in the same project, so
 * the seam between the two halves is just a return value.
 *
 * The key names are still snake_case (weight_kg, class_rank), which is not a
 * JavaScript convention and is not here for one: they matched the JSON the
 * Python wrote so the two could be diffed during the port. That is over.
 * Renaming them is free whenever it is convenient - the page is the only
 * reader, and CrewsJs.html is the only place that would have to follow.
 */

/**
 * A Date as local time, ISO-8601, with an explicit offset.
 *
 * Local because everything downstream is read by humans in Stockholm. The
 * Python called .astimezone() with no argument, which means the machine's zone;
 * here it is CONFIG.timeZone, which is the same thing said out loud.
 */
function localIso_(date) {
  if (!date) {
    return '';
  }
  return Utilities.formatDate(date, CONFIG.timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** The local calendar date, which is what names the sheet tab for a session. */
function localDate_(date) {
  return Utilities.formatDate(date, CONFIG.timeZone, 'yyyy-MM-dd');
}

/**
 * Build the payload from a snapshot and the boat inventory.
 *
 * Only rowers who accepted are listed per session - a crew is made of people
 * who said they are coming, and shipping the other 93% would just be noise.
 * `rowers` is the whole club, though: that is the roster view, and a rower who
 * has signed up for nothing is exactly the one a coach might want to look up.
 */
function buildPayload_(snapshot, boats) {
  var rowerIds = Object.keys(snapshot.rowers).sort(function (a, b) {
    return compareNames_(fullName_(snapshot.rowers[a]), fullName_(snapshot.rowers[b]));
  });

  return {
    generated_at: localIso_(snapshot.fetchedAt),
    group: snapshot.groupName,

    // Only available boats. A damaged boat, or one kept at the other lake,
    // stays in the inventory but must never be assigned at an open session,
    // and filtering here means the assigner cannot accidentally pick one.
    boats: boats
      .filter(function (boat) {
        return boat.available;
      })
      .map(function (boat) {
        return {
          name: boat.name,
          type: boat.type,
          seats: boat.seats,
          weight_kg: boat.weightKg,
          'class': boat.boatClass,
          // Position on the scale, so the assigner orders and compares classes
          // without carrying a second copy of the letters.
          class_rank: classRank_(boat.boatClass),
        };
      }),

    rowers: rowerIds.map(function (id) {
      var rower = snapshot.rowers[id];
      return {
        id: rower.id,
        name: fullName_(rower),
        level: rower.level === undefined ? null : rower.level,
      };
    }),

    // The club's own groups - Grupp 0 to Grupp 4, Magelungen, Hammarby
    // Herråtta - with who is in each, and who is in none.
    //
    // Deliberately without a level per member, even though every other list
    // here repeats one. The page reads the level off `rowers` by id as it
    // draws the pane, so it cannot show a stale one - and since the pane only
    // ever displays a level, there is nothing to keep a second copy in step
    // with.
    //
    // Added for the page, which the Python's export had no equivalent of -
    // this is the one field that was never in the JSON the C++ app read.
    groups: (snapshot.groups ? snapshot.groups.blocks : []).map(function (block) {
      return { name: block.name, members: block.members };
    }),
    ungrouped: snapshot.groups ? snapshot.groups.unplaced : [],

    sessions: snapshot.sessions.map(function (session) {
      var accepted = Object.keys(session.responses)
        .filter(function (id) {
          return session.responses[id] === 'accepted';
        })
        .sort(function (a, b) {
          return compareNames_(
            fullName_(snapshot.rowers[a]) || a,
            fullName_(snapshot.rowers[b]) || b
          );
        });

      var counts = { accepted: 0, declined: 0, unanswered: 0 };
      Object.keys(session.responses).forEach(function (id) {
        var status = session.responses[id];
        if (counts[status] !== undefined) {
          counts[status] += 1;
        }
      });

      return {
        id: session.id,
        // Pre-computed because it names the sheet tab the crews get written
        // to, and deriving it from a timestamp is one more thing to get wrong.
        date: localDate_(session.start),
        heading: session.heading,
        start: localIso_(session.start),
        accepted: accepted.map(function (id) {
          var rower = snapshot.rowers[id];
          return {
            id: id,
            name: fullName_(rower) || id,
            // Repeated here so the assigner never has to join the two lists.
            level: rower && rower.level !== undefined ? rower.level : null,
          };
        }),
        counts: counts,
      };
    }),
  };
}

/**
 * Pull everything and assemble the payload: Spond, plus both input tabs.
 *
 * This is the whole data layer in one call, and what the UI will hand to the
 * assigner once there is one.
 */
function buildFullPayload_() {
  var spreadsheet = openSpreadsheet_();
  var boats = loadBoats_(spreadsheet);
  // One sheet read, not two: levels come out of the Spond groups now, and
  // those arrive inside the snapshot pullSnapshot_ has already fetched.
  var snapshot = applyGroupLevels_(pullSnapshot_());
  return buildPayload_(snapshot, boats);
}

/**
 * Entry point: log the payload as JSON.
 *
 * The whole data layer in one call - Spond, the Boats tab, the group levels -
 * without a deployment to look at it through. Run it and read the execution
 * log when the page shows something wrong and you need to know which side of
 * google.script.run it went wrong on.
 */
function logPayload() {
  var payload = buildFullPayload_();

  console.log(
    'Group: %s   boats: %s   rowers: %s   sessions: %s',
    payload.group,
    payload.boats.length,
    payload.rowers.length,
    payload.sessions.length
  );

  // What the group rule made of the real club. A big "no boat" number is
  // Grupp 0 and expected. A big C number is worth a look: it is Grupp 1 and
  // Grupp 1a, plus anyone in no mapped group at all, and the second kind is a
  // gap in Spond rather than a judgement about a rower.
  var byLevel = { 'no boat': 0 };
  BOAT_CLASSES.forEach(function (letter) {
    byLevel[letter] = 0;
  });
  payload.rowers.forEach(function (rower) {
    byLevel[rower.level === null ? 'no boat' : rower.level] += 1;
  });
  console.log(
    'Levels from the club groups: %s.',
    Object.keys(byLevel)
      .map(function (key) {
        return byLevel[key] + ' ' + key;
      })
      .join(', ')
  );

  payload.sessions.forEach(function (session) {
    console.log(
      '  %s  %s  accepted %s',
      session.date,
      session.heading,
      session.counts.accepted
    );
  });

  // ensure_ascii=False on the Python side, and JSON.stringify is UTF-8 too, so
  // the Swedish names stay readable in both.
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}
