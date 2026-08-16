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
    // Every member of the Spond group, not just whoever accepted something.
    std::vector<crews::Rower> rowers;
    std::vector<crews::Session> sessions;
};

// One rower out of a JSON object, tolerating a null level for anyone the
// Rowers tab has not graded.
inline crews::Rower read_rower(const nlohmann::json& j) {
    crews::Rower rower;
    rower.id = j.value("id", "");
    rower.name = j.value("name", "");
    if (j.contains("level") && !j["level"].is_null()) {
        rower.level = j["level"].get<std::string>();
    }
    return rower;
}

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
        boat.type = b.value("type", "");
        boat.seats = b.value("seats", 0);
        // weight_kg and class/class_rank are null for hulls the club does not
        // rate and for boats not classed yet; value() would throw on null.
        if (b.contains("weight_kg") && !b["weight_kg"].is_null()) {
            boat.weight_kg = b["weight_kg"].get<int>();
        }
        if (b.contains("class") && !b["class"].is_null()) {
            boat.boat_class = b["class"].get<std::string>();
        }
        if (b.contains("class_rank") && !b["class_rank"].is_null()) {
            boat.class_rank = b["class_rank"].get<int>();
        }
        out.boats.push_back(boat);
    }

    for (const auto& r : doc.value("rowers", nlohmann::json::array())) {
        out.rowers.push_back(read_rower(r));
    }

    for (const auto& e : doc.value("sessions", nlohmann::json::array())) {
        crews::Session session;
        session.id = e.value("id", "");
        session.date = e.value("date", "");
        session.heading = e.value("heading", "");
        session.start = e.value("start", "");
        for (const auto& r : e.value("accepted", nlohmann::json::array())) {
            session.accepted.push_back(read_rower(r));
        }
        out.sessions.push_back(session);
    }
    return out;
}

inline nlohmann::json crews_payload(const crews::Session& session,
                                    const crews::Assignment& assignment,
                                    const std::string& generated_at) {
    nlohmann::json doc;
    doc["generated_at"] = generated_at;
    doc["session"] = {{"id", session.id},
                      {"date", session.date},
                      {"heading", session.heading},
                      {"start", session.start}};

    doc["crews"] = nlohmann::json::array();
    for (const auto& crew : assignment.crews) {
        // Occupied seats only, in seat order. An empty seat has no name to
        // write, and the sheet already shows the gap as "(3/4 seats)" from
        // the seats count below.
        nlohmann::json rowers = nlohmann::json::array();
        for (const auto& r : crew.seats) {
            if (!crews::occupied(r)) continue;
            rowers.push_back({{"id", r.id}, {"name", r.name}});
        }
        doc["crews"].push_back({{"boat", crew.boat.name},
                                {"type", crew.boat.type},
                                {"seats", crew.boat.seats},
                                {"weight_kg", crew.boat.weight_kg},
                                {"class", crew.boat.boat_class},
                                {"rowers", rowers}});
    }

    doc["unassigned"] = nlohmann::json::array();
    for (const auto& r : assignment.unassigned) {
        doc["unassigned"].push_back({{"id", r.id}, {"name", r.name}});
    }
    return doc;
}

// The roster with whatever levels the coach set, for `crew_bot levels` to push
// back to the Rowers tab of the sheet.
//
// Name and level only, matching the two columns that tab has - the id is not
// written because the sheet does not carry one to match it against.
inline nlohmann::json rowers_payload(const std::vector<crews::Rower>& rowers,
                                     const std::string& generated_at) {
    nlohmann::json doc;
    doc["generated_at"] = generated_at;
    doc["rowers"] = nlohmann::json::array();
    for (const auto& rower : rowers) {
        nlohmann::json entry;
        entry["name"] = rower.name;
        if (rower.level.empty()) {
            entry["level"] = nullptr;  // not graded, not the empty string
        } else {
            entry["level"] = rower.level;
        }
        doc["rowers"].push_back(entry);
    }
    return doc;
}

inline void write_rowers(const std::string& path,
                         const std::vector<crews::Rower>& rowers,
                         const std::string& generated_at) {
    std::ofstream out(path);
    if (!out) throw std::runtime_error("Cannot write " + path);
    out << rowers_payload(rowers, generated_at).dump(2) << "\n";
}

inline void write_crews(const std::string& path, const crews::Session& session,
                        const crews::Assignment& assignment,
                        const std::string& generated_at) {
    std::ofstream out(path);
    if (!out) throw std::runtime_error("Cannot write " + path);
    out << crews_payload(session, assignment, generated_at).dump(2) << "\n";
}

}  // namespace crewio
