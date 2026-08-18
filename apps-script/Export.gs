/**
 * The payload the crew assigner reads - a port of src/crew_bot/export.py.
 *
 * On the Python side this is written to data/attendance.json and handed to a
 * separate C++ program. Here it stays an object: the assigner will be JS in
 * the same project, so the file that used to be the seam between the two
 * halves becomes a return value.
 *
 * The key names are kept in snake_case (weight_kg, class_rank) exactly as
 * export.py writes them. Not because anything here needs them that way, but so
 * this can be diffed against a real data/attendance.json while both
 * implementations exist. Once the Python side is retired, this is the moment
 * to rename them.
 */

/**
 * A Date as export.py writes it: local time, ISO-8601, explicit offset.
 *
 * Local because everything downstream is read by humans in Stockholm. The
 * Python calls .astimezone() with no argument, which means the machine's zone;
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
  var levels = loadLevels_(spreadsheet);
  var snapshot = applyLevels_(pullSnapshot_(), levels);
  return buildPayload_(snapshot, boats);
}

/**
 * Entry point: log the payload as JSON.
 *
 * The check for this step. Run it, copy the JSON out of the execution log, and
 * diff it against a data/attendance.json produced by `crew_bot export` - the
 * key names, the ordering and the timestamp format were all kept identical so
 * that comes out clean.
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

  var graded = payload.rowers.filter(function (rower) {
    return rower.level !== null;
  }).length;
  console.log(
    '%s of %s rowers graded. Ungraded count as C, so until that number grows ' +
    'every crew goes out in a C boat.',
    graded,
    payload.rowers.length
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
