// Reading attendance.json and writing crews.json.
//
// Separate from main.cpp so the console self-test exercises exactly the same
// parsing and serialisation the GUI does - a test against a reimplementation
// would prove nothing about the real path.
#pragma once

#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "../vendor/json.hpp"
#include "crews.h"

namespace crewio {

struct Attendance {
    std::string group;
    std::string generated_at;
    std::vector<crews::Boat> boats;
    std::vector<crews::Session> sessions;
};

inline Attendance load_attendance(const std::string& path) {
    std::ifstream file(path);
    if (!file) {
        throw std::runtime_error("Cannot open " + path +
                                 "  --  run: python -m crew_bot export");
    }

    nlohmann::json doc;
    file >> doc;  // throws nlohmann::json::parse_error on malformed input

    Attendance out;
    out.group = doc.value("group", "");
    out.generated_at = doc.value("generated_at", "");

    for (const auto& b : doc.value("boats", nlohmann::json::array())) {
        crews::Boat boat;
        boat.name = b.value("name", "");
        boat.seats = b.value("seats", 0);
        boat.level = b.value("level", "");
        out.boats.push_back(boat);
    }

    for (const auto& e : doc.value("sessions", nlohmann::json::array())) {
        crews::Session session;
        session.id = e.value("id", "");
        session.date = e.value("date", "");
        session.heading = e.value("heading", "");
        session.start = e.value("start", "");
        for (const auto& r : e.value("accepted", nlohmann::json::array())) {
            crews::Rower rower;
            rower.id = r.value("id", "");
            rower.name = r.value("name", "");
            // level is null until the club decides where skill comes from.
            if (r.contains("level") && !r["level"].is_null()) {
                rower.level = r["level"].get<std::string>();
            }
            session.accepted.push_back(rower);
        }
        out.sessions.push_back(session);
    }
    return out;
}

inline nlohmann::json crews_payload(const crews::Session& session,
                                    const crews::Assignment& assignment,
                                    const std::string& generated_at) {
    nlohmann::json doc;
    doc["schema"] = 1;
    doc["generated_at"] = generated_at;
    doc["session"] = {{"id", session.id},
                      {"date", session.date},
                      {"heading", session.heading},
                      {"start", session.start}};

    doc["crews"] = nlohmann::json::array();
    for (const auto& crew : assignment.crews) {
        nlohmann::json rowers = nlohmann::json::array();
        for (const auto& r : crew.rowers) {
            rowers.push_back({{"id", r.id}, {"name", r.name}});
        }
        doc["crews"].push_back({{"boat", crew.boat.name},
                                {"seats", crew.boat.seats},
                                {"level", crew.boat.level},
                                {"rowers", rowers}});
    }

    doc["unassigned"] = nlohmann::json::array();
    for (const auto& r : assignment.unassigned) {
        doc["unassigned"].push_back({{"id", r.id}, {"name", r.name}});
    }
    return doc;
}

inline void write_crews(const std::string& path, const crews::Session& session,
                        const crews::Assignment& assignment,
                        const std::string& generated_at) {
    std::ofstream out(path);
    if (!out) throw std::runtime_error("Cannot write " + path);
    out << crews_payload(session, assignment, generated_at).dump(2) << "\n";
}

}  // namespace crewio
