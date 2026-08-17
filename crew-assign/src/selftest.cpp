// Console self-test: load attendance.json, assign crews, write crews.json.
//
// Uses io.h and crews.h - the same code the GUI runs - so this verifies the
// real path rather than a parallel implementation. Build with build.bat, run
// with: build\selftest.exe [attendance.json] [crews.json]

#include <cstdio>
#include <string>

#include "crews.h"
#include "io.h"

static int failures = 0;

static void check(bool condition, const std::string& what) {
    std::printf("%s %s\n", condition ? "PASS" : "FAIL", what.c_str());
    if (!condition) ++failures;
}

int main(int argc, char** argv) {
    const std::string in = argc > 1 ? argv[1] : "../data/attendance.json";
    const std::string out = argc > 2 ? argv[2] : "../data/crews.json";

    // --- synthetic case first: exercises the solver deterministically ------
    {
        crews::Session s;
        s.heading = "Test";
        for (int i = 0; i < 13; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), ""});
        }
        std::vector<crews::Boat> boats = {{"Four", "4x/4-", 4, 75, ""},
                                          {"Eight", "8+", 8, 85, ""},
                                          {"Double", "2x", 2, 70, ""}};

        crews::Assignment a = crews::assign(s, boats);

        // 8 + 4 = 12 seated; the last rower cannot fill the double, so the
        // double stays on the rack rather than launching half-crewed.
        check(a.crews.size() == 2, "13 rowers fill eight + four, double skipped");
        check(a.crews[0].boat.name == "Eight", "largest boat is filled first");
        check(a.crews[0].seats.size() == 8, "eight has 8 seats");
        check(crews::filled(a.crews[0]) == 8, "all 8 of them are filled");
        check(a.unassigned.size() == 1, "1 rower left over from 13");

        // Nobody may appear twice - the bug that would put a rower in two boats.
        std::vector<std::string> seen;
        for (const auto& c : a.crews)
            for (const auto& r : c.seats)
                if (crews::occupied(r)) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end(),
              "no rower appears in two boats");
        check(seen.size() == 13, "every rower is accounted for");
    }

    // --- taking a rower out of a boat -------------------------------------
    // The drag-to-pool action in the GUI. The seat has to stay behind, or the
    // rowers below it would all shuffle up a seat when one person leaves.
    //
    // The rowers here and in the sections below are graded to their boats on
    // purpose: these check the seat and boat mechanics, and a crew the level
    // rule would refuse would never reach them. The rule itself is checked in
    // its own section further down.
    {
        crews::Session s;
        for (int i = 0; i < 4; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), "B"});
        }
        std::vector<crews::Boat> boats = {{"Four", "4x/4-", 4, 75, "B", 2}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.size() == 1 && crews::filled(a.crews[0]) == 4,
              "the four starts full");

        const crews::Rower moved = crews::unseat(a, 0, 1);  // seat 2
        check(moved.id == "1", "unseat returns the rower who moved");
        check(a.crews[0].seats.size() == 4, "the boat still has 4 seats");
        check(crews::filled(a.crews[0]) == 3, "one of them is now empty");
        check(!crews::occupied(a.crews[0].seats[1]), "and it is the one vacated");
        check(a.crews[0].seats[2].id == "2",
              "the rower behind stays in their own seat");
        check(a.unassigned.size() == 1 && a.unassigned[0].id == "1",
              "the rower is back in the pool");

        // Still nobody in two places, which is the invariant an edit can break.
        std::vector<std::string> seen;
        for (const auto& r : a.crews[0].seats)
            if (crews::occupied(r)) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end() &&
                  seen.size() == 4,
              "everyone is still in exactly one place after the move");

        // A stray drop must change nothing rather than corrupt the assignment.
        check(!crews::occupied(crews::unseat(a, 0, 1)), "an empty seat stays empty");
        check(!crews::occupied(crews::unseat(a, 9, 0)), "an unknown boat is ignored");
        check(!crews::occupied(crews::unseat(a, 0, 99)), "an unknown seat is ignored");
        check(a.unassigned.size() == 1, "and none of that touched the pool");

        // Emptying a boat completely leaves the boat, not a hole in the list.
        crews::unseat(a, 0, 0);
        crews::unseat(a, 0, 2);
        crews::unseat(a, 0, 3);
        check(a.crews.size() == 1 && crews::filled(a.crews[0]) == 0,
              "an emptied boat stays in the list with all seats free");
        check(a.unassigned.size() == 4, "everyone is back in the pool");
        check(a.unassigned[0].name < a.unassigned[3].name,
              "the pool stays in name order");
    }

    // --- putting a rower from the pool into a seat ------------------------
    {
        crews::Session s;
        for (int i = 0; i < 5; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), "B"});
        }
        std::vector<crews::Boat> boats = {{"Four", "4x/4-", 4, 75, "B", 2}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.unassigned.size() == 1 && a.unassigned[0].id == "4",
              "one rower starts in the pool");

        // Into an empty seat: the pool shrinks, nobody is displaced.
        crews::unseat(a, 0, 2);
        check(a.unassigned.size() == 2, "two in the pool after taking one out");
        const crews::Rower seated = crews::seat_from_pool(a, 1, 0, 2);
        check(seated.id == "4", "seat_from_pool returns the rower who sat down");
        check(a.crews[0].seats[2].id == "4", "and they are in the seat aimed at");
        check(a.unassigned.size() == 1 && a.unassigned[0].id == "2",
              "the pool is down to the rower who was taken out");
        check(crews::filled(a.crews[0]) == 4, "the four is full again");

        // Onto a taken seat: the two swap, so the boat stays full and the
        // rower who was there is findable in the pool rather than lost.
        const crews::Rower bumped_into = crews::seat_from_pool(a, 0, 0, 0);
        check(bumped_into.id == "2", "the pool rower takes the occupied seat");
        check(a.crews[0].seats[0].id == "2", "they are sitting in it");
        check(a.unassigned.size() == 1 && a.unassigned[0].id == "0",
              "and the rower who was there is back in the pool");
        check(crews::filled(a.crews[0]) == 4, "the boat did not change size");

        // Stray drops change nothing.
        check(!crews::occupied(crews::seat_from_pool(a, 9, 0, 0)),
              "an unknown pool index is ignored");
        check(!crews::occupied(crews::seat_from_pool(a, 0, 0, 99)),
              "an unknown seat is ignored");
        check(a.unassigned.size() == 1, "and neither touched the pool");

        std::vector<std::string> seen;
        for (const auto& r : a.crews[0].seats)
            if (crews::occupied(r)) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end() &&
                  seen.size() == 5,
              "everyone is still in exactly one place");
    }

    // --- moving between seats ---------------------------------------------
    {
        crews::Session s;
        for (int i = 0; i < 6; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), "B"});
        }
        std::vector<crews::Boat> boats = {{"Four", "4x/4-", 4, 75, "B", 2},
                                          {"Double", "2x", 2, 70, "C", 1}};
        crews::Assignment a = crews::assign(s, boats);

        // Within a boat: a straight swap, the bowside/strokeside shuffle.
        check(crews::move_between_seats(a, 0, 0, 0, 3).id == "0",
              "moving within a boat returns the rower who moved");
        check(a.crews[0].seats[0].id == "3" && a.crews[0].seats[3].id == "0",
              "the two seats swapped");

        // Into an empty seat in another boat: the seat behind goes empty.
        crews::unseat(a, 1, 0);
        check(crews::move_between_seats(a, 0, 1, 1, 0).id == "1",
              "a rower can move to another boat");
        check(a.crews[1].seats[0].id == "1", "they arrive in the target seat");
        check(!crews::occupied(a.crews[0].seats[1]),
              "and the seat they left is empty, not closed up");

        check(!crews::occupied(crews::move_between_seats(a, 0, 1, 0, 2)),
              "dragging an empty seat does nothing");
        check(!crews::occupied(crews::move_between_seats(a, 0, 0, 0, 0)),
              "dropping a seat on itself does nothing");

        std::vector<std::string> seen;
        for (const auto& c : a.crews)
            for (const auto& r : c.seats)
                if (crews::occupied(r)) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end() &&
                  seen.size() == 6,
              "nobody was duplicated or dropped by all that dragging");
    }

    // --- adding, removing, clearing and swapping boats --------------------
    {
        crews::Session s;
        for (int i = 0; i < 8; ++i) {
            // AA, so every hull in the inventory below is open to them and the
            // boat operations are what is being checked.
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), "AA"});
        }
        // Inventory order, which is the order the + button walks.
        std::vector<crews::Boat> inventory = {{"Four", "4x/4-", 4, 75, "B", 2},
                                              {"Double", "2x", 2, 70, "C", 1},
                                              {"Single", "1x", 1, 70, "A", 3},
                                              {"Eight", "8+", 8, 85, "AA", 4}};

        // Starting from nothing, as the + button does before Assign crews.
        crews::Assignment a;
        a.unassigned = s.accepted;

        check(crews::first_free_boat(a, inventory) == 0,
              "the first free boat is the first one in the inventory");
        check(crews::add_crew(a, inventory[0]) == 0, "adding returns the new index");
        check(a.crews.size() == 1 && a.crews[0].seats.size() == 4,
              "the boat arrives with all its seats");
        check(crews::filled(a.crews[0]) == 0, "and nobody in them");
        check(a.unassigned.size() == 8, "adding a boat seats nobody");

        // A hull can only be on the water once.
        check(crews::add_crew(a, inventory[0]) == -1,
              "the same boat cannot be added twice");
        check(crews::first_free_boat(a, inventory) == 1,
              "the next + skips the boat already out");
        check(crews::add_crew(a, inventory[1]) == 1, "so the double goes out too");

        // Fill the four by hand to give the later operations something to move.
        for (int seat = 0; seat < 4; ++seat) crews::seat_from_pool(a, 0, 0, seat);
        check(crews::filled(a.crews[0]) == 4 && a.unassigned.size() == 4,
              "four rowers seated by hand");

        // clear: the boat stays, the crew goes back.
        check(crews::clear_crew(a, 0) == 4, "clear reports the crew it freed");
        check(a.crews.size() == 2, "the boat is still on the water");
        check(a.crews[0].seats.size() == 4 && crews::filled(a.crews[0]) == 0,
              "with all of its seats, all empty");
        check(a.unassigned.size() == 8, "and everyone is back in the pool");
        check(crews::clear_crew(a, 0) == 0, "clearing an empty boat frees nobody");

        // assign, on one boat: fills its empty seats from the pool.
        check(crews::fill_crew(a, 0) == 4, "assigning a boat fills all its seats");
        check(crews::filled(a.crews[0]) == 4 && a.unassigned.size() == 4,
              "and takes exactly that many out of the pool");
        check(crews::fill_crew(a, 0) == 0, "a full boat takes nobody");
        check(crews::fill_crew(a, 9) == -1, "an unknown boat is a no-op");

        // It tops up rather than re-seating: whoever is aboard stays put.
        crews::unseat(a, 0, 1);
        const std::string kept = a.crews[0].seats[0].id;
        check(crews::fill_crew(a, 0) == 1, "it fills just the seat that opened");
        check(a.crews[0].seats[0].id == kept, "the rest of the crew did not move");
        check(crews::filled(a.crews[0]) == 4, "and the boat is full again");

        // With fewer in the pool than empty seats it part-fills - the coach
        // picked this boat, so two in a four beats refusing.
        {
            crews::Assignment part;
            part.unassigned = {{"x", "Only", "AA"}, {"y", "Two", "AA"}};
            crews::add_crew(part, inventory[0]);  // a four
            check(crews::fill_crew(part, 0) == 2,
                  "a four takes the only two in the pool");
            check(crews::filled(part.crews[0]) == 2, "and launches part-crewed");
            check(part.unassigned.empty(), "with the pool emptied");
            check(crews::fill_crew(part, 0) == 0, "and nothing left to add");
        }

        // Put everyone back in the pool for the checks that follow.
        crews::clear_crew(a, 0);
        crews::clear_crew(a, 1);

        // remove: the boat goes away too.
        for (int seat = 0; seat < 2; ++seat) crews::seat_from_pool(a, 0, 1, seat);
        check(crews::remove_crew(a, 1) == 2, "remove reports the crew it freed");
        check(a.crews.size() == 1 && a.crews[0].boat.name == "Four",
              "and the boat is gone from the list");
        check(a.unassigned.size() == 8, "with its crew back in the pool");
        check(crews::remove_crew(a, 9) == -1, "removing an unknown boat is a no-op");
        check(crews::clear_crew(a, 9) == -1, "so is clearing one");

        // Swapping to a bigger hull keeps everyone and gains empty seats.
        for (int seat = 0; seat < 4; ++seat) crews::seat_from_pool(a, 0, 0, seat);
        check(crews::set_boat(a, 0, inventory[3]) == 0,
              "moving up to an eight displaces nobody");
        check(a.crews[0].seats.size() == 8 && crews::filled(a.crews[0]) == 4,
              "the crew keeps its seats and the eight gains empty ones");
        check(a.crews[0].boat.name == "Eight", "and the boat is the new one");

        // Swapping to a smaller one sends the seats off the end to the pool.
        const int pool_before = (int)a.unassigned.size();
        check(crews::set_boat(a, 0, inventory[1]) == 2,
              "moving down to a double displaces the two who do not fit");
        check(a.crews[0].seats.size() == 2, "the boat is a double now");
        check(crews::filled(a.crews[0]) == 2, "with the first two seats kept");
        check((int)a.unassigned.size() == pool_before + 2,
              "and the other two are in the pool");

        // A hull that is already out cannot be picked for a second crew.
        crews::add_crew(a, inventory[0]);
        check(crews::set_boat(a, 1, inventory[1]) == -1,
              "a boat already out is refused for another crew");
        check(crews::set_boat(a, 0, inventory[1]) == 0,
              "but a crew may re-pick the boat it is already in");

        std::vector<std::string> seen;
        for (const auto& c : a.crews)
            for (const auto& r : c.seats)
                if (crews::occupied(r)) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end() &&
                  seen.size() == 8,
              "nobody was lost or duplicated by any of that");
    }

    // --- a boat that cannot be filled must not launch half-crewed ---------
    {
        crews::Session s;
        s.accepted = {{"1", "A", ""}, {"2", "B", ""}, {"3", "C", ""}};
        std::vector<crews::Boat> boats = {{"Eight", "8+", 8, 85, ""},
                                          {"Double", "2x", 2, 70, ""}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.size() == 1 && a.crews[0].boat.name == "Double",
              "an eight is skipped when only 3 rowers turned up");
        check(a.unassigned.size() == 1, "the odd rower is left over, not seated");
    }

    // --- no rowers at all --------------------------------------------------
    {
        crews::Session s;
        std::vector<crews::Boat> boats = {{"Double", "2x", 2, 70, ""}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.empty() && a.unassigned.empty(), "empty session is safe");
    }

    // --- the level rule ----------------------------------------------------
    // A rower may take a boat only if their level reaches its class, every
    // seat, no exceptions. Ungraded counts as C, the bottom of the scale.
    {
        const crews::Boat tub{"Tub", "2x", 2, 70, "C", 1};
        const crews::Boat shell{"Shell", "2x", 2, 70, "AA", 4};
        const crews::Boat unclassed{"Unclassed", "2x", 2, 70, "", 0};

        check(crews::level_rank("C") == 1 && crews::level_rank("AA") == 4,
              "a level's rank matches the boat class it is named after");
        check(crews::level_rank("") == 0, "an ungraded rower has no rank");
        check(crews::rower_rank({"1", "Nobody", ""}) == 1,
              "but counts as C when it comes to boats");

        check(crews::may_row({"1", "Ungraded", ""}, tub),
              "an ungraded rower may take a C boat");
        check(!crews::may_row({"1", "Ungraded", ""}, shell),
              "but not an AA one");
        check(crews::may_row({"1", "Ungraded", ""}, unclassed),
              "an unclassed hull constrains nobody");
        check(crews::may_row({"1", "Strong", "AA"}, tub),
              "a strong rower may still take an easy boat");
        check(crews::may_row({"1", "Exact", "B"}, {"B boat", "2x", 2, 70, "B", 2}),
              "meeting the class exactly is enough");
    }

    // A boat nobody may take is skipped, however many turned up.
    {
        crews::Session s;
        for (int i = 0; i < 4; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), ""});
        }
        std::vector<crews::Boat> boats = {{"Racer", "4x/4-", 4, 75, "A", 3},
                                          {"Tub", "4x/4-", 4, 75, "C", 1}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.size() == 1 && a.crews[0].boat.name == "Tub",
              "four ungraded rowers get the C four, not the A one");
        check(a.unassigned.empty(), "and all four of them are in it");
        check(crews::under_classed(a.crews[0]) == 0,
              "the solver never produces an under-classed crew");
    }

    // The weakest eligible rowers are spent first, so the strong ones are
    // still in the pool when a demanding hull comes round. Without that, the
    // C double here would take the two AA rowers by name order and the AA
    // double would have nobody left to launch with.
    {
        crews::Session s;
        s.accepted = {{"1", "Ava", "AA"},
                      {"2", "Axel", "AA"},
                      {"3", "Cec", "C"},
                      {"4", "Cyd", "C"}};
        // Equal seats, so the boats are taken in name order: the C one first.
        std::vector<crews::Boat> boats = {{"Alpha", "2x", 2, 70, "C", 1},
                                          {"Zeta", "2x", 2, 70, "AA", 4}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.size() == 2, "both doubles go out");
        check(a.crews[0].seats[0].name == "Cec" &&
                  a.crews[0].seats[1].name == "Cyd",
              "the C double takes the two C rowers");
        check(a.crews[1].seats[0].name == "Ava" &&
                  a.crews[1].seats[1].name == "Axel",
              "leaving the AA double the two who can row it");
        check(a.unassigned.empty(), "nobody is left on the dock");
        check(a.crews[0].seats[0].name < a.crews[0].seats[1].name,
              "and a crew is still seated in name order");
    }

    // An ungraded roster behaves exactly as it did before levels existed.
    {
        crews::Session s;
        for (int i = 0; i < 13; ++i) {
            s.accepted.push_back({std::to_string(i), "Rower " + std::to_string(i), ""});
        }
        std::vector<crews::Boat> boats = {{"Four", "4x/4-", 4, 75, "C", 1},
                                          {"Eight", "8+", 8, 85, "C", 1},
                                          {"Double", "2x", 2, 70, "C", 1}};
        crews::Assignment a = crews::assign(s, boats);
        check(a.crews.size() == 2 && a.crews[0].boat.name == "Eight",
              "13 ungraded rowers fill the C eight and four as before");
        check(a.crews[0].seats[0].id == "0" && a.crews[0].seats[7].id == "7",
              "in the order they arrived, since nothing sorts equal levels");
        check(a.unassigned.size() == 1 && a.unassigned[0].id == "12",
              "and the same rower is left over");
    }

    // Filling one boat by hand steps over the rowers it is too much for, and
    // leaves them in the pool rather than seating them.
    {
        crews::Assignment a;
        a.unassigned = {{"1", "Ava", "AA"}, {"2", "Cec", "C"}};
        const crews::Boat shell{"Shell", "2x", 2, 70, "AA", 4};
        check(crews::add_crew(a, shell) == 0, "the AA double goes out empty");

        check(crews::fill_crew(a, 0) == 1,
              "filling it seats only the rower who may take it");
        check(a.crews[0].seats[0].name == "Ava", "and it is the AA one");
        check(a.unassigned.size() == 1 && a.unassigned[0].name == "Cec",
              "the C rower stays in the pool");
        check(crews::fill_crew(a, 0) == 0,
              "asking again seats nobody rather than looping");
        check(crews::under_classed(a.crews[0]) == 0, "the half crew is legal");

        // The coach's own override: allowed, and counted.
        check(crews::seat_from_pool(a, 0, 0, 1).name == "Cec",
              "but a coach can still drag them in by hand");
        check(crews::under_classed(a.crews[0]) == 1,
              "and that is what under_classed reports");
        check(crews::filled(a.crews[0]) == 2, "with the boat full either way");
    }

    // --- boat class survives the JSON hop ---------------------------------
    // Written out and read back through io.h rather than hand-built, because
    // the risk is in the parsing: `class` and `class_rank` are null for an
    // unclassed boat, and get<>() on a null throws.
    {
        const std::string path = out + ".classtest.json";
        {
            std::ofstream f(path);
            f << R"({"boats":[
                     {"name":"Bajen","type":"8+","seats":8,"weight_kg":85,
                      "class":"B","class_rank":2},
                     {"name":"Cecil","type":"Trimmer","seats":1,
                      "weight_kg":null,"class":null,"class_rank":null}],
                     "sessions":[]})";
        }
        crewio::Attendance att = crewio::load_attendance(path);
        check(att.boats.size() == 2, "both boats parsed");
        check(att.boats[0].boat_class == "B" && att.boats[0].class_rank == 2,
              "a classed boat keeps its class and rank");
        check(att.boats[1].boat_class.empty() && att.boats[1].class_rank == 0,
              "an unclassed boat reads as empty/0 rather than throwing");
        check(crews::label(att.boats[0]).find("B") != std::string::npos,
              "the class shows in the boat label");
        std::remove(path.c_str());
    }

    // --- the roster and its levels ----------------------------------------
    // The Rowers tab reads this list and writes levels back out for
    // `crew_bot levels`, so both directions are worth pinning.
    {
        const std::string path = out + ".rostertest.json";
        {
            std::ofstream f(path);
            f << R"({"rowers":[
                     {"id":"m1","name":"Anna Berg","level":"B"},
                     {"id":"m2","name":"Bjorn Dahl","level":null}],
                     "boats":[],"sessions":[]})";
        }
        crewio::Attendance att = crewio::load_attendance(path);
        check(att.rowers.size() == 2, "the whole roster is read, not just crews");
        check(att.rowers[0].level == "B", "a graded rower keeps their level");
        check(att.rowers[1].level.empty(),
              "an ungraded one reads as empty rather than throwing");
        std::remove(path.c_str());

        // What the coach edits in the dropdown, on its way back to the sheet.
        std::vector<crews::Rower> edited = att.rowers;
        edited[1].level = "AA";
        edited[0].level.clear();  // cleared back to "not set"
        const nlohmann::json doc = crewio::rowers_payload(edited, "now");
        check(doc["rowers"].size() == 2, "every rower is written out");
        check(doc["rowers"][1]["level"] == "AA", "a set level is written");
        check(doc["rowers"][0]["level"].is_null(),
              "a cleared level is null, so the sheet cell is blanked");
        check(doc["rowers"][0].contains("name") &&
                  !doc["rowers"][0].contains("id"),
              "name only - the Rowers tab has no id column to match on");
    }

    // --- now the real exported file ---------------------------------------
    std::printf("\nReading %s\n", in.c_str());
    try {
        crewio::Attendance att = crewio::load_attendance(in);
        std::printf("  group: %s\n", att.group.c_str());
        std::printf("  boats: %d, sessions: %d\n", (int)att.boats.size(),
                    (int)att.sessions.size());
        check(!att.sessions.empty(), "real file has at least one session");

        int best = 0;
        for (int i = 0; i < (int)att.sessions.size(); ++i) {
            if (att.sessions[i].accepted.size() >
                att.sessions[best].accepted.size())
                best = i;
        }
        const crews::Session& session = att.sessions[best];
        std::printf("  using %s (%d accepted)\n", session.heading.c_str(),
                    (int)session.accepted.size());

        crews::Assignment a = crews::assign(session, att.boats);
        std::printf("\n");
        for (const auto& c : a.crews) {
            std::printf("  %s (%d seats)\n", crews::label(c.boat).c_str(),
                        c.boat.seats);
            int seat = 1;
            for (const auto& r : c.seats) {
                std::printf("    %d. %s\n", seat++,
                            crews::occupied(r) ? r.name.c_str() : "--");
            }
        }
        if (!a.unassigned.empty()) {
            std::printf("  not assigned:\n");
            for (const auto& r : a.unassigned)
                std::printf("    %s\n", r.name.c_str());
        }

        size_t seated = 0;
        for (const auto& c : a.crews) seated += crews::filled(c);
        check(seated + a.unassigned.size() == session.accepted.size(),
              "seated + leftover equals the number who accepted");

        crewio::write_crews(out, session, a, att.generated_at);
        std::printf("\nWrote %s\n", out.c_str());
    } catch (const std::exception& e) {
        std::printf("FAIL exception: %s\n", e.what());
        ++failures;
    }

    std::printf("\n%s\n", failures == 0 ? "All checks passed."
                                        : "SOME CHECKS FAILED");
    return failures == 0 ? 0 : 1;
}
