// Crew assignment: the actual rowing logic, kept free of any UI or JSON so it
// can be reasoned about (and later tested) on its own.
#pragma once

#include <algorithm>
#include <string>
#include <vector>

namespace crews {

struct Rower {
    std::string id;
    std::string name;
    std::string level;  // empty for now: where skill comes from is undecided
};

struct Boat {
    std::string name;
    int seats = 0;
    std::string level;
};

struct Session {
    std::string id;
    std::string date;
    std::string heading;
    std::string start;
    std::vector<Rower> accepted;
};

struct Crew {
    Boat boat;
    std::vector<Rower> rowers;
};

struct Assignment {
    std::vector<Crew> crews;
    std::vector<Rower> unassigned;
};

// Fill the largest boats first with whoever has accepted.
//
// Deliberately ignores rower level: the club has not decided how rowers map to
// experienced/mid/beginner yet (Spond's Grupp 0-4 subgroups may or may not
// encode it). Boat level is carried through to the output so a coach can see
// it, but it does not currently constrain who goes in which boat.
//
// Big boats first because a part-filled eight is a worse outcome than a
// part-filled double: it strands more people on the dock.
inline Assignment assign(const Session& session, const std::vector<Boat>& boats) {
    Assignment result;

    std::vector<Boat> usable;
    for (const auto& boat : boats) {
        if (boat.seats > 0) usable.push_back(boat);
    }
    std::sort(usable.begin(), usable.end(), [](const Boat& a, const Boat& b) {
        if (a.seats != b.seats) return a.seats > b.seats;
        return a.name < b.name;
    });

    std::vector<Rower> pool = session.accepted;
    size_t next = 0;

    for (const auto& boat : usable) {
        if (next >= pool.size()) break;

        const size_t remaining = pool.size() - next;
        // Only launch a boat we can fill. A half-crewed eight cannot row.
        if (remaining < static_cast<size_t>(boat.seats)) continue;

        Crew crew;
        crew.boat = boat;
        for (int seat = 0; seat < boat.seats; ++seat) {
            crew.rowers.push_back(pool[next++]);
        }
        result.crews.push_back(std::move(crew));
    }

    for (; next < pool.size(); ++next) {
        result.unassigned.push_back(pool[next]);
    }
    return result;
}

}  // namespace crews
