// Crew assignment: the actual rowing logic, kept free of any UI or JSON so it
// can be reasoned about (and later tested) on its own.
#pragma once

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace crews {

struct Rower {
    std::string id;
    std::string name;
    std::string level;  // empty for now: where skill comes from is undecided
};

struct Boat {
    std::string name;
    std::string type;        // rowing shorthand as the Boats tab writes it: "8+"
    int seats = 0;           // crew size, taken from the type by the exporter
    int weight_kg = 0;       // crew weight the hull is built for; 0 = unrated
    std::string boat_class;  // the Class column: "C", "B", "A" or "AA"
    // Where that class sits on the club's scale: C=1, B=2, A=3, AA=4, and 0
    // for a boat the Boats tab has not classed. Comes from the exporter so the
    // letters are spelt out in exactly one place (BOAT_CLASSES in models.py);
    // compare ranks here rather than parsing boat_class.
    int class_rank = 0;
};

// "Bajen  8+  85 kg" - built here rather than at the call sites so the GUI and
// the self-test describe a boat the same way.
inline std::string label(const Boat& boat) {
    std::string out = boat.name;
    if (!boat.type.empty()) out += "  " + boat.type;
    if (boat.weight_kg > 0) out += "  " + std::to_string(boat.weight_kg) + " kg";
    if (!boat.boat_class.empty()) out += "  " + boat.boat_class;
    return out;
}

struct Session {
    std::string id;
    std::string date;
    std::string heading;
    std::string start;
    std::vector<Rower> accepted;
};

struct Crew {
    Boat boat;
    // Always exactly boat.seats long, bow to stern. An empty seat is a
    // default-constructed Rower rather than a gap in the vector: a four with
    // nobody in seat 2 is still a four, and the rower in seat 3 must stay in
    // seat 3 when the one ahead is taken out.
    std::vector<Rower> seats;
};

// A seat nobody is sitting in. Ids come from Spond and are never blank for a
// real rower, so the empty id is what tells the two apart - a name could in
// principle be blank, an id could not.
inline bool occupied(const Rower& rower) { return !rower.id.empty(); }

inline int filled(const Crew& crew) {
    int count = 0;
    for (const auto& rower : crew.seats)
        if (occupied(rower)) ++count;
    return count;
}

struct Assignment {
    std::vector<Crew> crews;
    // Everyone who accepted but is not in a boat: the pool a coach drags
    // people out of and back into. Kept in name order.
    std::vector<Rower> unassigned;
};

// The seat at these indices, or nullptr if either is out of range. Every edit
// below goes through this, so a stray drop from the UI is a no-op rather than
// something that has to be bounds-checked at each call site.
inline Rower* seat_at(Assignment& assignment, int crew_index, int seat_index) {
    if (crew_index < 0 || crew_index >= (int)assignment.crews.size()) return nullptr;
    Crew& crew = assignment.crews[crew_index];
    if (seat_index < 0 || seat_index >= (int)crew.seats.size()) return nullptr;
    return &crew.seats[seat_index];
}

inline const Rower* seat_at(const Assignment& assignment, int crew_index,
                            int seat_index) {
    return seat_at(const_cast<Assignment&>(assignment), crew_index, seat_index);
}

// Put a rower in the pool, in name order rather than at the end: the pool
// arrives sorted (the exporter sorts by name), and a coach looking for someone
// should not have to check the bottom of the list as well as the middle.
inline void into_pool(Assignment& assignment, const Rower& rower) {
    auto at = std::lower_bound(
        assignment.unassigned.begin(), assignment.unassigned.end(), rower,
        [](const Rower& a, const Rower& b) { return a.name < b.name; });
    assignment.unassigned.insert(at, rower);
}

// Take the rower out of one seat and put them back in the pool.
//
// The seat is emptied rather than removed, and the boat stays in the
// assignment even if it empties completely - the coach took one person out of
// a boat, they did not put the boat away.
//
// Returns the rower who moved, or an empty Rower if nothing did: an
// out-of-range or already-empty seat is a stray drop the UI should ignore
// rather than a reason to corrupt the assignment.
inline Rower unseat(Assignment& assignment, int crew_index, int seat_index) {
    Rower* seat = seat_at(assignment, crew_index, seat_index);
    if (seat == nullptr || !occupied(*seat)) return {};

    const Rower moved = *seat;
    into_pool(assignment, moved);
    *seat = Rower{};
    return moved;
}

// Seat someone from the pool.
//
// Dropping onto a seat that is already taken swaps the two: the rower sitting
// there goes back to the pool. Refusing the drop instead would be the more
// cautious rule, but a coach aiming at an occupied seat means to put this
// person *there*, and the displaced rower reappears in the pool where they can
// be seen and dragged somewhere else.
//
// Returns the rower who was seated, or an empty Rower if nothing moved.
inline Rower seat_from_pool(Assignment& assignment, int pool_index,
                            int crew_index, int seat_index) {
    if (pool_index < 0 || pool_index >= (int)assignment.unassigned.size()) return {};
    Rower* seat = seat_at(assignment, crew_index, seat_index);
    if (seat == nullptr) return {};

    // By value, and erased before anyone is put back, so the pool index cannot
    // be shifted out from under us by the displaced rower's insertion.
    const Rower incoming = assignment.unassigned[pool_index];
    assignment.unassigned.erase(assignment.unassigned.begin() + pool_index);
    if (occupied(*seat)) into_pool(assignment, *seat);
    *seat = incoming;
    return incoming;
}

// Is this hull already out in this assignment?
//
// A boat can only be on the water once, so it can only be in one crew. Names
// identify a boat here: the club's inventory has one row per hull and the
// names are what a coach says out loud on the dock. `except_crew` is the crew
// asking - a boat is not "in use" by the crew already in it.
inline bool boat_in_use(const Assignment& assignment, const std::string& name,
                        int except_crew = -1) {
    for (int i = 0; i < (int)assignment.crews.size(); ++i) {
        if (i == except_crew) continue;
        if (assignment.crews[i].boat.name == name) return true;
    }
    return false;
}

// The first boat in the inventory that is not already out, or -1 if they all
// are. Inventory order, which is the Boats tab's own order.
inline int first_free_boat(const Assignment& assignment,
                           const std::vector<Boat>& inventory) {
    for (int i = 0; i < (int)inventory.size(); ++i) {
        if (inventory[i].seats > 0 && !boat_in_use(assignment, inventory[i].name)) {
            return i;
        }
    }
    return -1;
}

// Put another boat on the water, all seats empty for the coach to fill.
//
// Returns the new crew's index, or -1 if the boat has no seats or is already
// out.
inline int add_crew(Assignment& assignment, const Boat& boat) {
    if (boat.seats <= 0 || boat_in_use(assignment, boat.name)) return -1;
    Crew crew;
    crew.boat = boat;
    crew.seats.resize(boat.seats);
    assignment.crews.push_back(std::move(crew));
    return (int)assignment.crews.size() - 1;
}

// Take a boat off the water entirely. Its crew goes back to the pool.
//
// Returns how many rowers that freed, or -1 for an unknown crew.
inline int remove_crew(Assignment& assignment, int crew_index) {
    if (crew_index < 0 || crew_index >= (int)assignment.crews.size()) return -1;
    int freed = 0;
    for (Rower& seat : assignment.crews[crew_index].seats) {
        if (occupied(seat)) {
            into_pool(assignment, seat);
            ++freed;
        }
    }
    assignment.crews.erase(assignment.crews.begin() + crew_index);
    return freed;
}

// Fill one boat's empty seats from the pool, bow first.
//
// Anyone already sitting in it stays put: this tops a boat up rather than
// re-seating it, so a coach can place the two people who must row together and
// then let this find the rest.
//
// Unlike `assign` it will part-fill a boat. The rule there - never launch a
// boat you cannot crew - is about choosing which boats go out at all. Here the
// coach has already chosen this boat, so three in a four is a more useful
// answer than refusing and leaving them to drag by hand.
//
// Returns how many rowers sat down, or -1 for an unknown crew.
inline int fill_crew(Assignment& assignment, int crew_index) {
    if (crew_index < 0 || crew_index >= (int)assignment.crews.size()) return -1;

    Crew& crew = assignment.crews[crew_index];
    int seated = 0;
    for (Rower& seat : crew.seats) {
        if (assignment.unassigned.empty()) break;
        if (occupied(seat)) continue;
        seat = assignment.unassigned.front();
        assignment.unassigned.erase(assignment.unassigned.begin());
        ++seated;
    }
    return seated;
}

// Empty a boat but leave it on the water, ready to be filled again.
//
// Returns how many rowers went back to the pool, or -1 for an unknown crew.
inline int clear_crew(Assignment& assignment, int crew_index) {
    if (crew_index < 0 || crew_index >= (int)assignment.crews.size()) return -1;
    int freed = 0;
    for (Rower& seat : assignment.crews[crew_index].seats) {
        if (occupied(seat)) {
            into_pool(assignment, seat);
            seat = Rower{};
            ++freed;
        }
    }
    return freed;
}

// Swap a crew into a different hull, keeping whoever fits where they are.
//
// A bigger boat gains empty seats at the stern. A smaller one loses the seats
// off the end, and anyone sitting in them goes back to the pool - the seats
// that survive keep their rowers rather than everyone shuffling forward,
// because a seat number means something in a boat.
//
// Returns how many rowers that displaced, or -1 if the crew is unknown or the
// hull is already out with another crew.
inline int set_boat(Assignment& assignment, int crew_index, const Boat& boat) {
    if (crew_index < 0 || crew_index >= (int)assignment.crews.size()) return -1;
    if (boat.seats <= 0 || boat_in_use(assignment, boat.name, crew_index)) return -1;

    Crew& crew = assignment.crews[crew_index];
    int displaced = 0;
    for (int seat = boat.seats; seat < (int)crew.seats.size(); ++seat) {
        if (occupied(crew.seats[seat])) {
            into_pool(assignment, crew.seats[seat]);
            ++displaced;
        }
    }
    crew.seats.resize(boat.seats);  // grows with empty seats, shrinks off the end
    crew.boat = boat;
    return displaced;
}

// Move a rower from one seat to another, in the same boat or a different one.
//
// A swap, so dropping onto a taken seat exchanges the two rowers and dropping
// onto an empty one leaves the seat behind empty. This is the bowside /
// strokeside shuffle, and it never changes how many people are in the boat.
//
// Returns the rower who moved, or an empty Rower if nothing did.
inline Rower move_between_seats(Assignment& assignment, int from_crew,
                                int from_seat, int to_crew, int to_seat) {
    if (from_crew == to_crew && from_seat == to_seat) return {};
    Rower* from = seat_at(assignment, from_crew, from_seat);
    Rower* to = seat_at(assignment, to_crew, to_seat);
    if (from == nullptr || to == nullptr || !occupied(*from)) return {};

    const Rower moved = *from;
    std::swap(*from, *to);
    return moved;
}

// Fill the largest boats first with whoever has accepted.
//
// Deliberately ignores rower level and boat class. The boat side of that is
// now decided - the Boats tab classes each hull C to AA, and class_rank
// carries the order - but the rower side is not: Spond's Grupp 0-4 subgroups
// may or may not encode skill. Until a rower has a level to compare against,
// there is nothing to match a class to. Both are carried through to the output
// so a coach can see them, but neither constrains who goes in which boat.
//
// Boats that are damaged or kept at the other lake never reach this function:
// the exporter drops them.
//
// Big boats first because a part-filled eight is a worse outcome than a
// part-filled double: it strands more people on the dock.
//
// Every crew this returns is full. Seats only become empty afterwards, when a
// coach takes someone out with `unseat`.
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
        crew.seats.resize(boat.seats);  // every seat exists, filled or not
        for (int seat = 0; seat < boat.seats; ++seat) {
            crew.seats[seat] = pool[next++];
        }
        result.crews.push_back(std::move(crew));
    }

    for (; next < pool.size(); ++next) {
        result.unassigned.push_back(pool[next]);
    }
    return result;
}

}  // namespace crews
