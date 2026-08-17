// crew-assign: pick a session, assign crews, write crews.json.
//
// Reads the attendance.json produced by `python -m crew_bot export`, and writes
// a crews.json that `python -m crew_bot crews` pushes to that day's sheet tab.
// This app never talks to Google or Spond - it is a solver with a window.

#include "imgui.h"
#include "imgui_impl_dx11.h"
#include "imgui_impl_win32.h"

#include <d3d11.h>
#include <tchar.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "crews.h"
#include "io.h"

// ---------------------------------------------------------------- app state

struct AppState {
    std::string in_path = "../data/attendance.json";
    std::string out_path = "../data/crews.json";
    std::string status = "Click Load to read attendance.json.";
    bool status_is_error = false;

    std::string group;
    std::string generated_at;
    std::vector<crews::Boat> boats;
    std::vector<crews::Session> sessions;

    // The whole club. Levels here are edited in the Rowers tab and written to
    // rowers.json; the sheet, not this app, is where they actually live.
    std::vector<crews::Rower> roster;
    std::string rowers_path = "../data/rowers.json";

    int selected = 0;
    bool have_assignment = false;
    crews::Assignment assignment;

    // Whose details the Rowers tab is showing. By Spond id rather than by
    // list position, so it survives a reload or a change of session.
    std::string selected_rower;
};

// Where a rower is being dragged from, or to. `crew` indexes the assignment's
// crews and `seat` the seat within it - except when `crew` is kPool, and
// `seat` indexes the pool instead.
//
// Indices rather than a pointer or a name: ImGui memcpy's the payload, the
// vectors behind it can move, and two rowers can share a name.
static const int kPool = -1;

struct SeatRef {
    int crew = kPool;
    int seat = -1;
};

struct Move {
    SeatRef from;
    SeatRef to;
};

// What the coach asked for while the lists were being drawn. Nothing is
// applied until drawing has finished: removing a boat mid-iteration would
// invalidate the very vector being walked, and the seat indices a drop
// carries only mean anything against the state that was drawn.
enum class Act { None, MoveRower, Fill, Remove, Clear, SwapBoat, AddBoat };

struct Action {
    Act what = Act::None;
    Move move;      // MoveRower
    int crew = -1;  // Fill, Remove, Clear, SwapBoat
    int boat = -1;  // SwapBoat: an index into AppState::boats
};

static const char* kSeatPayload = "CREW_SEAT";

// Marks a rower sitting in a boat their level does not reach. The same red the
// status line uses for a refusal, because it is the same thing being said.
static const ImVec4 kWarn = ImVec4(1.0f, 0.5f, 0.4f, 1.0f);

static void set_error(AppState& s, const std::string& message) {
    s.status = message;
    s.status_is_error = true;
}

static void set_ok(AppState& s, const std::string& message) {
    s.status = message;
    s.status_is_error = false;
}

// A rower's level for display: "C", or "not graded" for anybody the Rowers tab
// has no level for.
static std::string level_text(const crews::Rower& rower) {
    return rower.level.empty() ? "not graded" : rower.level;
}

// What a placement the level rule would refuse has to say for itself, e.g.
// "  --  Sara Lind is C, Kaza is class A". Empty when the seat is legal.
//
// Dragging is never refused - a coach who wants this crew in this boat has
// reasons the sheet does not know about - so this is the whole of the
// enforcement on a manual move: say plainly what was just overridden.
static std::string class_warning(const crews::Rower& rower,
                                 const crews::Boat& boat) {
    if (crews::may_row(rower, boat)) return "";
    return "  --  " + rower.name + " is " + level_text(rower) + ", " +
           boat.name + " is class " + boat.boat_class;
}

// Everything a drop can mean, in one place. Called after the lists are drawn,
// never while they are being iterated.
static void apply_move(AppState& s, const Move& move) {
    const bool from_pool = move.from.crew == kPool;
    const bool to_pool = move.to.crew == kPool;

    if (from_pool && to_pool) return;  // dropped back where it came from

    if (to_pool) {
        const crews::Rower moved =
            crews::unseat(s.assignment, move.from.crew, move.from.seat);
        if (crews::occupied(moved)) set_ok(s, moved.name + " is back in the pool.");
        return;
    }

    // Who is sitting there now, so the message can mention being bumped.
    const crews::Rower* target =
        crews::seat_at(s.assignment, move.to.crew, move.to.seat);
    const std::string displaced =
        (target != nullptr && crews::occupied(*target)) ? target->name : "";

    crews::Rower moved;
    if (from_pool) {
        moved = crews::seat_from_pool(s.assignment, move.from.seat, move.to.crew,
                                      move.to.seat);
    } else {
        moved = crews::move_between_seats(s.assignment, move.from.crew,
                                          move.from.seat, move.to.crew,
                                          move.to.seat);
    }
    if (!crews::occupied(moved)) return;

    const crews::Crew& crew = s.assignment.crews[move.to.crew];
    std::string message = moved.name + " -> " + crew.boat.name + " seat " +
                          std::to_string(move.to.seat + 1);
    if (!displaced.empty()) {
        // Swapped with a seat, or bumped from one - either way the coach needs
        // to know where the other rower went.
        message += from_pool ? ", " + displaced + " back to the pool"
                             : ", swapped with " + displaced;
    }
    message += ".";

    // The move stands either way; only the colour and the tail of the line
    // change. A swap can put two rowers out of their class at once, so both
    // seats are checked rather than just the one dropped on.
    std::string warning = class_warning(moved, crew.boat);
    if (!displaced.empty() && !from_pool) {
        const crews::Rower* back = crews::seat_at(s.assignment, move.from.crew,
                                                  move.from.seat);
        if (back != nullptr && crews::occupied(*back)) {
            warning += class_warning(*back,
                                     s.assignment.crews[move.from.crew].boat);
        }
    }
    if (warning.empty()) {
        set_ok(s, message);
    } else {
        set_error(s, message + warning);
    }
}

// Everyone who accepted, nobody in a boat yet. The starting point both for
// "Assign crews" and for a coach who skips it and builds the crews by hand.
static crews::Assignment start_assignment(const crews::Session& session) {
    crews::Assignment assignment;
    assignment.unassigned = session.accepted;  // already in name order
    return assignment;
}

static std::string rowers_freed(int count) {
    if (count == 0) return "";
    return "  (" + std::to_string(count) + " rower" + (count == 1 ? "" : "s") +
           " back to the pool)";
}

static void apply_action(AppState& s, const Action& action,
                         const crews::Session& session) {
    // Every crews:: call below bounds-checks and returns -1 rather than
    // trusting these indices, so a click on a boat that has since gone is a
    // no-op rather than a crash.
    const bool known_crew = action.crew >= 0 &&
                            action.crew < (int)s.assignment.crews.size();
    const std::string boat_name =
        known_crew ? s.assignment.crews[action.crew].boat.name : "";

    switch (action.what) {
        case Act::None:
            return;

        case Act::MoveRower:
            apply_move(s, action.move);
            return;

        case Act::Fill: {
            const int seated = crews::fill_crew(s.assignment, action.crew);
            if (seated < 0) return;
            const crews::Crew& crew = s.assignment.crews[action.crew];
            const int empty = crew.boat.seats - crews::filled(crew);

            // A seat left empty with people still in the pool means the class
            // stopped them, not the numbers - the one case a coach would
            // otherwise stare at the screen over.
            const bool blocked = empty > 0 && !s.assignment.unassigned.empty();
            const std::string because =
                blocked ? "  --  nobody left in the pool is " +
                              crew.boat.boat_class + " or better"
                        : "";

            if (seated == 0) {
                if (empty == 0) {
                    set_error(s, boat_name + " is already full.");
                } else if (s.assignment.unassigned.empty()) {
                    set_error(s, "Nobody left in the pool.");
                } else {
                    set_error(s, "Seated nobody in " + boat_name + because + ".");
                }
                return;
            }

            std::string message =
                "Seated " + std::to_string(seated) + " in " + boat_name;
            if (empty > 0) {
                // Say so rather than leaving a short crew to be noticed later.
                message += "  (" + std::to_string(empty) + " seat" +
                           (empty == 1 ? "" : "s") + " still empty)";
            }
            set_ok(s, message + because + ".");
            return;
        }

        case Act::Remove: {
            const int freed = crews::remove_crew(s.assignment, action.crew);
            if (freed >= 0) {
                set_ok(s, "Took " + boat_name + " off the water." +
                              rowers_freed(freed));
            }
            return;
        }

        case Act::Clear: {
            const int freed = crews::clear_crew(s.assignment, action.crew);
            if (freed >= 0) {
                set_ok(s, "Emptied " + boat_name + "." + rowers_freed(freed));
            }
            return;
        }

        case Act::SwapBoat: {
            if (action.boat < 0 || action.boat >= (int)s.boats.size()) return;
            const crews::Boat& boat = s.boats[action.boat];
            const int displaced = crews::set_boat(s.assignment, action.crew, boat);
            if (displaced < 0) {
                set_error(s, boat.name + " is already out with another crew.");
                return;
            }
            const std::string message =
                boat_name + " -> " + boat.name + "." + rowers_freed(displaced);
            // Moving a crew up a class does not throw anyone out - the same
            // override a drag gets - but it must not happen silently.
            const int over = crews::under_classed(s.assignment.crews[action.crew]);
            if (over > 0) {
                set_error(s, message + "  --  " + std::to_string(over) +
                                 " aboard " + (over == 1 ? "is" : "are") +
                                 " below class " + boat.boat_class + ".");
            } else {
                set_ok(s, message);
            }
            return;
        }

        case Act::AddBoat: {
            // The + button doubles as the way to start from an empty sheet
            // without letting the solver seat anyone first.
            if (!s.have_assignment) {
                s.assignment = start_assignment(session);
                s.have_assignment = true;
            }
            const int pick = crews::first_free_boat(s.assignment, s.boats);
            if (pick < 0) {
                set_error(s, s.boats.empty()
                                 ? "No boats were exported. Check the Boats tab."
                                 : "Every available boat is already out.");
                return;
            }
            const int added = crews::add_crew(s.assignment, s.boats[pick]);
            if (added >= 0) {
                set_ok(s, "Added " + s.boats[pick].name +
                              ".  Pick a different one from its dropdown, or "
                              "drag rowers into it.");
            }
            return;
        }
    }
}

// Look next to the exe and one level up, so the app works whether it is
// launched from crew-assign/ or from the repo root.
static std::string find_existing(const std::string& relative) {
    namespace fs = std::filesystem;
    for (const std::string& prefix : {"", "../", "../../"}) {
        std::string candidate = prefix + relative;
        if (fs::exists(candidate)) return candidate;
    }
    return relative;
}

static void load_attendance(AppState& s) {
    crewio::Attendance loaded;
    try {
        loaded = crewio::load_attendance(s.in_path);
    } catch (const std::exception& e) {
        set_error(s, e.what());
        return;
    }

    s.group = loaded.group;
    s.generated_at = loaded.generated_at;
    s.boats = loaded.boats;
    s.roster = loaded.rowers;
    s.sessions = loaded.sessions;
    s.selected = 0;
    s.have_assignment = false;

    if (s.sessions.empty()) {
        set_error(s, "No sessions in that file. Is anything scheduled?");
        return;
    }
    set_ok(s, "Loaded " + std::to_string(s.sessions.size()) + " sessions and " +
                  std::to_string(s.boats.size()) + " boats.");
}

static void write_crews(AppState& s) {
    if (!s.have_assignment) {
        set_error(s, "Assign crews first.");
        return;
    }
    try {
        crewio::write_crews(s.out_path, s.sessions[s.selected], s.assignment,
                            s.generated_at);
    } catch (const std::exception& e) {
        set_error(s, e.what());
        return;
    }
    set_ok(s, "Wrote " + s.out_path + "  --  now run: python -m crew_bot crews");
}

// ------------------------------------------------------------- the rowers tab

static void write_rowers(AppState& s) {
    try {
        crewio::write_rowers(s.rowers_path, s.roster, s.generated_at);
    } catch (const std::exception& e) {
        set_error(s, e.what());
        return;
    }
    set_ok(s, "Wrote " + s.rowers_path +
                  "  --  now run: python -m crew_bot levels");
}

// Where a level sits in kLevels, or -1 for a rower who has not been graded.
static int level_index(const std::string& level) {
    return crews::level_rank(level) - 1;  // level_rank is 1-based, 0 = ungraded
}

// Carry a level just set in the Rowers tab to every copy of that rower.
//
// The roster the dropdown edits is not what the crews are made of: `assign`
// reads the session's accepted list, and the seats and the pool hold copies of
// their own. Now that the level decides which boats a rower can take, grading
// someone and pressing Assign crews has to use the level on the screen rather
// than the one the file was exported with.
static void spread_level(AppState& s, const crews::Rower& graded) {
    for (crews::Session& session : s.sessions) {
        for (crews::Rower& rower : session.accepted) {
            if (rower.id == graded.id) rower.level = graded.level;
        }
    }
    for (crews::Crew& crew : s.assignment.crews) {
        for (crews::Rower& rower : crew.seats) {
            if (rower.id == graded.id) rower.level = graded.level;
        }
    }
    for (crews::Rower& rower : s.assignment.unassigned) {
        if (rower.id == graded.id) rower.level = graded.level;
    }
}

// Where this rower is sitting in the assignment on screen, in words. Empty if
// there is no assignment yet or they are not part of the selected session.
static std::string seat_description(const AppState& s, const std::string& id) {
    if (!s.have_assignment) return "";
    for (const crews::Crew& crew : s.assignment.crews) {
        for (int seat = 0; seat < (int)crew.seats.size(); ++seat) {
            if (crew.seats[seat].id == id) {
                return crew.boat.name + ", seat " + std::to_string(seat + 1);
            }
        }
    }
    for (const crews::Rower& rower : s.assignment.unassigned) {
        if (rower.id == id) return "in the pool";
    }
    return "";
}

// `rower` is the live roster entry, because the level dropdown edits it.
static void draw_rower_details(AppState& s, crews::Rower& rower) {
    ImGui::SeparatorText(rower.name.c_str());
    ImGui::Spacing();

    ImGui::TextDisabled("Spond id");
    ImGui::TextWrapped("%s", rower.id.c_str());
    ImGui::Spacing();

    ImGui::TextDisabled("Level");
    const int chosen = level_index(rower.level);
    ImGui::SetNextItemWidth(160.0f);
    if (ImGui::BeginCombo("##level", chosen < 0 ? "not set" : rower.level.c_str())) {
        // "not set" is a real choice, not just the empty state: a level set by
        // mistake has to be clearable, and blank is what the sheet stores.
        if (ImGui::Selectable("not set", chosen < 0)) {
            rower.level.clear();
            spread_level(s, rower);
        }
        for (int i = 0; i < crews::kLevelCount; ++i) {
            if (ImGui::Selectable(crews::kLevels[i], i == chosen)) {
                rower.level = crews::kLevels[i];
                spread_level(s, rower);
            }
            if (i == chosen) ImGui::SetItemDefaultFocus();
        }
        ImGui::EndCombo();
    }
    ImGui::TextDisabled("Same scale as the boat classes, lowest to highest.");
    ImGui::TextDisabled("A rower may take any boat up to their own level;");
    ImGui::TextDisabled("not set counts as C, the stable trainers.");
    ImGui::TextDisabled("Set it here, then Write rowers.json below.");
    ImGui::Spacing();

    ImGui::TextDisabled("Accepted");
    int accepted_count = 0;
    for (const crews::Session& session : s.sessions) {
        for (const crews::Rower& other : session.accepted) {
            if (other.id != rower.id) continue;
            ImGui::BulletText("%s  %s", session.date.c_str(),
                              session.heading.c_str());
            ++accepted_count;
            break;
        }
    }
    if (accepted_count == 0) ImGui::TextDisabled("none of the loaded sessions");
    ImGui::Spacing();

    const std::string seat = seat_description(s, rower.id);
    if (!seat.empty()) {
        ImGui::TextDisabled("In the current crews");
        ImGui::TextWrapped("%s", seat.c_str());
    }
}

static void draw_rowers_tab(AppState& s) {
    if (s.roster.empty()) {
        // An older attendance.json has no roster in it at all, which is a
        // re-export away rather than anything to fix here.
        ImGui::TextWrapped(
            "No rowers in this file. Run `python -m crew_bot rowers` to build "
            "the Rowers tab of the sheet, then `python -m crew_bot export` "
            "again.");
        return;
    }

    int graded = 0;
    for (const crews::Rower& rower : s.roster) {
        if (!rower.level.empty()) ++graded;
    }
    ImGui::Text("%d rowers in %s, %d with a level", (int)s.roster.size(),
                s.group.c_str(), graded);

    ImGui::Spacing();
    if (ImGui::Button("Write rowers.json", ImVec2(160, 0))) write_rowers(s);
    ImGui::SameLine();
    ImGui::SetNextItemWidth(320.0f);
    char rbuf[512];
    snprintf(rbuf, sizeof(rbuf), "%s", s.rowers_path.c_str());
    if (ImGui::InputText("##rowers_out", rbuf, sizeof(rbuf))) s.rowers_path = rbuf;
    ImGui::Spacing();

    float pane_height = ImGui::GetContentRegionAvail().y;
    if (pane_height < 200.0f) pane_height = 200.0f;

    if (ImGui::BeginTable("rower_panes", 2, ImGuiTableFlags_BordersInnerV)) {
        ImGui::TableNextRow();

        ImGui::TableSetColumnIndex(0);
        if (ImGui::BeginChild("rower_list", ImVec2(0, pane_height))) {
            for (int i = 0; i < (int)s.roster.size(); ++i) {
                ImGui::PushID(i);
                // Full width so the buttons read as a list rather than as a
                // ragged column sized to the longest name. The level rides on
                // the label so the list doubles as an overview of who is
                // graded.
                const crews::Rower& rower = s.roster[i];
                char label[256];
                snprintf(label, sizeof(label), "%s%s%s", rower.name.c_str(),
                         rower.level.empty() ? "" : "   ", rower.level.c_str());
                if (ImGui::Button(label, ImVec2(-FLT_MIN, 0))) {
                    s.selected_rower = rower.id;
                }
                ImGui::PopID();
            }
        }
        ImGui::EndChild();

        ImGui::TableSetColumnIndex(1);
        if (ImGui::BeginChild("rower_details", ImVec2(0, pane_height))) {
            crews::Rower* chosen = nullptr;
            for (crews::Rower& rower : s.roster) {
                if (rower.id == s.selected_rower) {
                    chosen = &rower;
                    break;
                }
            }
            if (chosen == nullptr) {
                ImGui::TextDisabled("Pick a rower on the left.");
            } else {
                draw_rower_details(s, *chosen);
            }
        }
        ImGui::EndChild();

        ImGui::EndTable();
    }
}

// ------------------------------------------------------------------- the UI

static void draw_assignment_tab(AppState& s) {
    // --- session picker
    const crews::Session& current = s.sessions[s.selected];
    std::string preview = current.heading + "  -  " + current.start;
    if (ImGui::BeginCombo("session", preview.c_str())) {
        for (int i = 0; i < (int)s.sessions.size(); ++i) {
            const crews::Session& e = s.sessions[i];
            std::string label = e.heading + "  -  " + e.start + "   (" +
                                std::to_string(e.accepted.size()) + " accepted)";
            if (ImGui::Selectable(label.c_str(), i == s.selected)) {
                s.selected = i;
                s.have_assignment = false;
            }
        }
        ImGui::EndCombo();
    }

    ImGui::Text("%d accepted   %d boats available",
                (int)current.accepted.size(), (int)s.boats.size());

    ImGui::Spacing();
    if (ImGui::Button("Assign crews", ImVec2(160, 0))) {
        s.assignment = crews::assign(current, s.boats);
        s.have_assignment = true;
        set_ok(s, "Assigned " + std::to_string(s.assignment.crews.size()) +
                      " boats, " +
                      std::to_string(s.assignment.unassigned.size()) +
                      " rowers left over.");
    }
    ImGui::SameLine();
    if (ImGui::Button("Write crews.json", ImVec2(160, 0))) write_crews(s);
    ImGui::Separator();

    // --- two columns: the pool on the left, the boats and their seats right
    //
    // Nothing is mutated while the lists are being drawn. A drop only records
    // which seat it came from, and the move is applied once the table is
    // closed - editing the vectors mid-iteration is how this crashes.
    Action pending;

    // Leave room under the table for the output path box. Panes scroll, so a
    // Saturday with forty rowers does not run off the bottom of the window.
    float pane_height = ImGui::GetContentRegionAvail().y -
                        ImGui::GetFrameHeightWithSpacing() * 2.0f;
    if (pane_height < 200.0f) pane_height = 200.0f;

    if (ImGui::BeginTable("panes", 2, ImGuiTableFlags_BordersInnerV)) {
        ImGui::TableNextRow();

        // --- left: the pool
        ImGui::TableSetColumnIndex(0);
        if (!s.have_assignment) {
            ImGui::SeparatorText("Accepted");
        } else {
            ImGui::SeparatorText(
                ("Pool (" + std::to_string(s.assignment.unassigned.size()) + ")")
                    .c_str());
        }

        if (ImGui::BeginChild("pool", ImVec2(0, pane_height))) {
            const std::vector<crews::Rower>& pool =
                s.have_assignment ? s.assignment.unassigned : current.accepted;
            for (int i = 0; i < (int)pool.size(); ++i) {
                ImGui::PushID(i);
                // The level rides on the same line: it is what decides which
                // boats this rower can be dropped into, so it has to be
                // visible while dragging them.
                char line[256];
                snprintf(line, sizeof(line), "%s%s%s", pool[i].name.c_str(),
                         pool[i].level.empty() ? "" : "   ",
                         pool[i].level.c_str());
                ImGui::Selectable(line);
                // Only draggable once there are boats to drag into.
                if (s.have_assignment && ImGui::BeginDragDropSource()) {
                    SeatRef from{kPool, i};
                    ImGui::SetDragDropPayload(kSeatPayload, &from, sizeof(from));
                    ImGui::TextUnformatted(pool[i].name.c_str());
                    ImGui::EndDragDropSource();
                }
                ImGui::PopID();
            }

            if (s.have_assignment) {
                // Only prompt while a rower is actually in the air, only for
                // our own payload type, and not when they came from the pool
                // in the first place.
                const ImGuiPayload* dragging = ImGui::GetDragDropPayload();
                if (dragging && dragging->IsDataType(kSeatPayload) &&
                    ((const SeatRef*)dragging->Data)->crew != kPool) {
                    ImGui::TextDisabled("  drop here to take out of the boat");
                }
                // Whatever is left of the pane is drop target as well, so a
                // coach can aim at the empty space below the names rather
                // than having to hit a one-line-tall row.
                ImVec2 rest = ImGui::GetContentRegionAvail();
                if (rest.y < ImGui::GetTextLineHeight()) {
                    rest.y = ImGui::GetTextLineHeight();
                }
                ImGui::Dummy(rest);
            }
        }
        ImGui::EndChild();
        // The whole pane accepts a rower, not just the names in it.
        if (ImGui::BeginDragDropTarget()) {
            const ImGuiPayload* payload = ImGui::AcceptDragDropPayload(kSeatPayload);
            if (payload) {
                pending.what = Act::MoveRower;
                pending.move = Move{*(const SeatRef*)payload->Data,
                                    SeatRef{kPool, -1}};
            }
            ImGui::EndDragDropTarget();
        }

        // --- right: the boats
        ImGui::TableSetColumnIndex(1);
        ImGui::SeparatorText("Crews");
        if (ImGui::BeginChild("crews", ImVec2(0, pane_height))) {
            if (s.have_assignment) {
                for (int ci = 0; ci < (int)s.assignment.crews.size(); ++ci) {
                    const crews::Crew& crew = s.assignment.crews[ci];
                    ImGui::PushID(ci);

                    // The boat itself is a dropdown: every hull that is not
                    // already out with another crew, plus this one.
                    ImGui::SetNextItemWidth(
                        ImGui::GetContentRegionAvail().x * 0.55f);
                    if (ImGui::BeginCombo("##boat",
                                          crews::label(crew.boat).c_str())) {
                        for (int bi = 0; bi < (int)s.boats.size(); ++bi) {
                            const crews::Boat& option = s.boats[bi];
                            if (crews::boat_in_use(s.assignment, option.name, ci)) {
                                continue;
                            }
                            const bool current = option.name == crew.boat.name;
                            if (ImGui::Selectable(crews::label(option).c_str(),
                                                  current)) {
                                pending.what = Act::SwapBoat;
                                pending.crew = ci;
                                pending.boat = bi;
                            }
                            if (current) ImGui::SetItemDefaultFocus();
                        }
                        ImGui::EndCombo();
                    }

                    ImGui::SameLine();
                    if (ImGui::Button("-")) {
                        pending.what = Act::Remove;
                        pending.crew = ci;
                    }
                    ImGui::SetItemTooltip(
                        "Take %s off the water. Its crew goes back to the pool.",
                        crew.boat.name.c_str());

                    ImGui::SameLine();
                    if (ImGui::Button("assign")) {
                        pending.what = Act::Fill;
                        pending.crew = ci;
                    }
                    ImGui::SetItemTooltip(
                        "Fill the empty seats in %s from the pool. Anyone "
                        "already aboard stays where they are.",
                        crew.boat.name.c_str());

                    ImGui::SameLine();
                    if (ImGui::Button("clear")) {
                        pending.what = Act::Clear;
                        pending.crew = ci;
                    }
                    ImGui::SetItemTooltip(
                        "Empty %s but keep it on the water.",
                        crew.boat.name.c_str());

                    ImGui::SameLine();
                    ImGui::TextDisabled("%d/%d seats", crews::filled(crew),
                                        crew.boat.seats);

                    // Only ever from a coach's own drag: the solver does not
                    // produce one. Called out on the boat as well as on the
                    // seat, so a crew that needs a second look is findable
                    // without reading every name in every boat.
                    const int over = crews::under_classed(crew);
                    if (over > 0) {
                        ImGui::SameLine();
                        ImGui::TextColored(kWarn, "%d below class %s", over,
                                           crew.boat.boat_class.c_str());
                    }

                    ImGui::Indent();
                    // Every seat is drawn, filled or not: an empty seat is the
                    // thing a coach is looking for, so it has to be visible.
                    for (int si = 0; si < (int)crew.seats.size(); ++si) {
                        const crews::Rower& rower = crew.seats[si];
                        const bool taken = crews::occupied(rower);
                        ImGui::PushID(si);

                        // A rower the boat is too demanding for is marked
                        // rather than removed: the coach put them there on
                        // purpose, and the mark is what makes it a decision
                        // instead of an oversight.
                        const bool over_boat = taken && !crews::may_row(rower, crew.boat);

                        char row[256];
                        snprintf(row, sizeof(row), "%d.  %s%s%s%s", si + 1,
                                 taken ? rower.name.c_str() : "--",
                                 taken && !rower.level.empty() ? "   " : "",
                                 rower.level.c_str(),
                                 over_boat ? "   below class" : "");

                        // An empty seat is a Selectable too, greyed rather
                        // than TextDisabled: it needs to be a full-width drop
                        // target, and a line of text is a thin thing to aim a
                        // rower at.
                        if (!taken) {
                            ImGui::PushStyleColor(
                                ImGuiCol_Text,
                                ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
                        } else if (over_boat) {
                            ImGui::PushStyleColor(ImGuiCol_Text, kWarn);
                        }
                        ImGui::Selectable(row);
                        if (!taken || over_boat) ImGui::PopStyleColor();

                        if (taken && ImGui::BeginDragDropSource()) {
                            SeatRef from{ci, si};
                            ImGui::SetDragDropPayload(kSeatPayload, &from,
                                                      sizeof(from));
                            ImGui::TextUnformatted(rower.name.c_str());
                            ImGui::EndDragDropSource();
                        }

                        // Every seat accepts a drop, empty or not: an occupied
                        // one swaps rather than refusing.
                        if (ImGui::BeginDragDropTarget()) {
                            const ImGuiPayload* payload =
                                ImGui::AcceptDragDropPayload(kSeatPayload);
                            if (payload) {
                                pending.what = Act::MoveRower;
                                pending.move = Move{*(const SeatRef*)payload->Data,
                                                    SeatRef{ci, si}};
                            }
                            ImGui::EndDragDropTarget();
                        }
                        ImGui::PopID();
                    }
                    ImGui::Unindent();

                    ImGui::PopID();
                    ImGui::Spacing();
                }
            }

            // Always available, including before Assign crews has been
            // pressed: adding a boat is also how you start from nothing and
            // build the crews entirely by hand.
            if (ImGui::Button("+")) pending.what = Act::AddBoat;
            ImGui::SetItemTooltip("Put the next free boat on the water.");
        }
        ImGui::EndChild();

        ImGui::EndTable();
    }

    // --- apply what was asked for, now that nothing is being iterated
    apply_action(s, pending, current);

    ImGui::Spacing();
    char obuf[512];
    snprintf(obuf, sizeof(obuf), "%s", s.out_path.c_str());
    if (ImGui::InputText("crews.json out", obuf, sizeof(obuf))) s.out_path = obuf;
}

static void draw_ui(AppState& s) {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::Begin("crew-assign", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse);

    // --- input file + load, above the tabs: it feeds both of them
    char buf[512];
    snprintf(buf, sizeof(buf), "%s", s.in_path.c_str());
    if (ImGui::InputText("attendance.json", buf, sizeof(buf))) s.in_path = buf;
    ImGui::SameLine();
    if (ImGui::Button("Load")) load_attendance(s);

    if (!s.group.empty()) {
        ImGui::TextDisabled("%s   exported %s", s.group.c_str(),
                            s.generated_at.c_str());
    }

    // The status line lives here rather than inside a tab so that a load
    // error is still readable from whichever tab is open.
    ImGui::TextColored(s.status_is_error ? kWarn : ImVec4(0.6f, 0.9f, 0.6f, 1.0f),
                       "%s", s.status.c_str());
    ImGui::Separator();

    if (s.sessions.empty()) {
        ImGui::TextWrapped("No sessions loaded.");
        ImGui::End();
        return;
    }

    if (ImGui::BeginTabBar("tabs")) {
        if (ImGui::BeginTabItem("Assignment")) {
            draw_assignment_tab(s);
            ImGui::EndTabItem();
        }
        if (ImGui::BeginTabItem("Rowers")) {
            draw_rowers_tab(s);
            ImGui::EndTabItem();
        }
        ImGui::EndTabBar();
    }

    ImGui::End();
}

// ------------------------------------------------- Win32 + DX11 boilerplate
// Adapted from imgui/examples/example_win32_directx11.

static ID3D11Device* g_pd3dDevice = nullptr;
static ID3D11DeviceContext* g_pd3dDeviceContext = nullptr;
static IDXGISwapChain* g_pSwapChain = nullptr;
static bool g_SwapChainOccluded = false;
static UINT g_ResizeWidth = 0, g_ResizeHeight = 0;
static ID3D11RenderTargetView* g_mainRenderTargetView = nullptr;

bool CreateDeviceD3D(HWND hWnd);
void CleanupDeviceD3D();
void CreateRenderTarget();
void CleanupRenderTarget();
LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

int main(int, char**) {
    ImGui_ImplWin32_EnableDpiAwareness();
    float main_scale = ImGui_ImplWin32_GetDpiScaleForMonitor(
        ::MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY));

    WNDCLASSEXW wc = {sizeof(wc), CS_CLASSDC, WndProc, 0L, 0L,
                      GetModuleHandle(nullptr), nullptr, nullptr, nullptr,
                      nullptr, L"crew-assign", nullptr};
    ::RegisterClassExW(&wc);
    HWND hwnd = ::CreateWindowW(wc.lpszClassName, L"crew-assign",
                                WS_OVERLAPPEDWINDOW, 100, 100,
                                (int)(1100 * main_scale), (int)(760 * main_scale),
                                nullptr, nullptr, wc.hInstance, nullptr);

    if (!CreateDeviceD3D(hwnd)) {
        CleanupDeviceD3D();
        ::UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return 1;
    }

    ::ShowWindow(hwnd, SW_SHOWDEFAULT);
    ::UpdateWindow(hwnd);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = nullptr;  // don't litter an imgui.ini next to the exe

    ImGui::StyleColorsDark();
    ImGuiStyle& style = ImGui::GetStyle();
    style.ScaleAllSizes(main_scale);
    style.FontScaleDpi = main_scale;

    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    // The built-in font is ASCII only, which would mangle names like
    // "Linnea Odborn Jonsson". Segoe UI ships with Windows and its default
    // glyph range covers Latin-1, which is all Swedish needs.
    style.FontSizeBase = 18.0f;
    if (!io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf")) {
        io.Fonts->AddFontDefault();
    }

    AppState state;
    state.in_path = find_existing("data/attendance.json");
    state.out_path = find_existing("data/crews.json");
    state.rowers_path = find_existing("data/rowers.json");
    // find_existing falls back to the bare relative path; put the outputs
    // beside whatever attendance.json we actually found.
    if (!std::filesystem::exists(state.out_path)) {
        std::filesystem::path p(state.in_path);
        p.replace_filename("crews.json");
        state.out_path = p.string();
    }
    if (!std::filesystem::exists(state.rowers_path)) {
        std::filesystem::path p(state.in_path);
        p.replace_filename("rowers.json");
        state.rowers_path = p.string();
    }
    load_attendance(state);

    bool done = false;
    while (!done) {
        MSG msg;
        while (::PeekMessage(&msg, nullptr, 0U, 0U, PM_REMOVE)) {
            ::TranslateMessage(&msg);
            ::DispatchMessage(&msg);
            if (msg.message == WM_QUIT) done = true;
        }
        if (done) break;

        if (g_SwapChainOccluded &&
            g_pSwapChain->Present(0, DXGI_PRESENT_TEST) == DXGI_STATUS_OCCLUDED) {
            ::Sleep(10);
            continue;
        }
        g_SwapChainOccluded = false;

        if (g_ResizeWidth != 0 && g_ResizeHeight != 0) {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, g_ResizeWidth, g_ResizeHeight,
                                        DXGI_FORMAT_UNKNOWN, 0);
            g_ResizeWidth = g_ResizeHeight = 0;
            CreateRenderTarget();
        }

        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        draw_ui(state);

        ImGui::Render();
        const float clear[4] = {0.10f, 0.11f, 0.13f, 1.00f};
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clear);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

        HRESULT hr = g_pSwapChain->Present(1, 0);
        g_SwapChainOccluded = (hr == DXGI_STATUS_OCCLUDED);
    }

    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();

    CleanupDeviceD3D();
    ::DestroyWindow(hwnd);
    ::UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return 0;
}

bool CreateDeviceD3D(HWND hWnd) {
    DXGI_SWAP_CHAIN_DESC sd;
    ZeroMemory(&sd, sizeof(sd));
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 0;
    sd.BufferDesc.Height = 0;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60;
    sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hWnd;
    sd.SampleDesc.Count = 1;
    sd.SampleDesc.Quality = 0;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    UINT createDeviceFlags = 0;
    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL featureLevelArray[2] = {
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_0,
    };
    HRESULT res = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, createDeviceFlags,
        featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain,
        &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (res == DXGI_ERROR_UNSUPPORTED)
        res = D3D11CreateDeviceAndSwapChain(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, createDeviceFlags,
            featureLevelArray, 2, D3D11_SDK_VERSION, &sd, &g_pSwapChain,
            &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (res != S_OK) return false;

    CreateRenderTarget();
    return true;
}

void CleanupDeviceD3D() {
    CleanupRenderTarget();
    if (g_pSwapChain) { g_pSwapChain->Release(); g_pSwapChain = nullptr; }
    if (g_pd3dDeviceContext) { g_pd3dDeviceContext->Release(); g_pd3dDeviceContext = nullptr; }
    if (g_pd3dDevice) { g_pd3dDevice->Release(); g_pd3dDevice = nullptr; }
}

void CreateRenderTarget() {
    ID3D11Texture2D* pBackBuffer;
    g_pSwapChain->GetBuffer(0, IID_PPV_ARGS(&pBackBuffer));
    g_pd3dDevice->CreateRenderTargetView(pBackBuffer, nullptr,
                                         &g_mainRenderTargetView);
    pBackBuffer->Release();
}

void CleanupRenderTarget() {
    if (g_mainRenderTargetView) {
        g_mainRenderTargetView->Release();
        g_mainRenderTargetView = nullptr;
    }
}

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg,
                                                             WPARAM wParam,
                                                             LPARAM lParam);

LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam)) return true;

    switch (msg) {
        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) return 0;
            g_ResizeWidth = (UINT)LOWORD(lParam);
            g_ResizeHeight = (UINT)HIWORD(lParam);
            return 0;
        case WM_SYSCOMMAND:
            if ((wParam & 0xfff0) == SC_KEYMENU) return 0;
            break;
        case WM_DESTROY:
            ::PostQuitMessage(0);
            return 0;
    }
    return ::DefWindowProcW(hWnd, msg, wParam, lParam);
}
