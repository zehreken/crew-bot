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
        check(a.crews[0].rowers.size() == 8, "eight gets 8 rowers");
        check(a.unassigned.size() == 1, "1 rower left over from 13");

        // Nobody may appear twice - the bug that would put a rower in two boats.
        std::vector<std::string> seen;
        for (const auto& c : a.crews)
            for (const auto& r : c.rowers) seen.push_back(r.id);
        for (const auto& r : a.unassigned) seen.push_back(r.id);
        std::sort(seen.begin(), seen.end());
        check(std::adjacent_find(seen.begin(), seen.end()) == seen.end(),
              "no rower appears in two boats");
        check(seen.size() == 13, "every rower is accounted for");
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
            for (const auto& r : c.rowers)
                std::printf("    %d. %s\n", seat++, r.name.c_str());
        }
        if (!a.unassigned.empty()) {
            std::printf("  not assigned:\n");
            for (const auto& r : a.unassigned)
                std::printf("    %s\n", r.name.c_str());
        }

        size_t seated = 0;
        for (const auto& c : a.crews) seated += c.rowers.size();
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
