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

    int selected = 0;
    bool have_assignment = false;
    crews::Assignment assignment;
};

static void set_error(AppState& s, const std::string& message) {
    s.status = message;
    s.status_is_error = true;
}

static void set_ok(AppState& s, const std::string& message) {
    s.status = message;
    s.status_is_error = false;
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

// ------------------------------------------------------------------- the UI

static void draw_ui(AppState& s) {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::Begin("crew-assign", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse);

    // --- input file + load
    char buf[512];
    snprintf(buf, sizeof(buf), "%s", s.in_path.c_str());
    if (ImGui::InputText("attendance.json", buf, sizeof(buf))) s.in_path = buf;
    ImGui::SameLine();
    if (ImGui::Button("Load")) load_attendance(s);

    if (!s.group.empty()) {
        ImGui::TextDisabled("%s   exported %s", s.group.c_str(),
                            s.generated_at.c_str());
    }

    ImGui::Separator();

    if (s.sessions.empty()) {
        ImGui::TextWrapped("No sessions loaded.");
        ImGui::Spacing();
        ImGui::TextColored(s.status_is_error ? ImVec4(1.0f, 0.5f, 0.4f, 1.0f)
                                             : ImVec4(0.6f, 0.9f, 0.6f, 1.0f),
                           "%s", s.status.c_str());
        ImGui::End();
        return;
    }

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

    ImGui::Spacing();
    ImGui::TextColored(s.status_is_error ? ImVec4(1.0f, 0.5f, 0.4f, 1.0f)
                                         : ImVec4(0.6f, 0.9f, 0.6f, 1.0f),
                       "%s", s.status.c_str());
    ImGui::Separator();

    // --- two columns: who accepted, and the resulting crews
    if (ImGui::BeginTable("panes", 2, ImGuiTableFlags_BordersInnerV)) {
        ImGui::TableNextRow();

        ImGui::TableSetColumnIndex(0);
        ImGui::SeparatorText("Accepted");
        for (const auto& r : current.accepted) {
            ImGui::BulletText("%s", r.name.c_str());
        }

        ImGui::TableSetColumnIndex(1);
        ImGui::SeparatorText("Crews");
        if (!s.have_assignment) {
            ImGui::TextDisabled("Press Assign crews.");
        } else {
            for (const auto& crew : s.assignment.crews) {
                ImGui::Text("%s  (%d seats, %s)", crew.boat.name.c_str(),
                            crew.boat.seats, crew.boat.level.c_str());
                ImGui::Indent();
                int seat = 1;
                for (const auto& r : crew.rowers) {
                    ImGui::Text("%d. %s", seat++, r.name.c_str());
                }
                ImGui::Unindent();
                ImGui::Spacing();
            }
            if (!s.assignment.unassigned.empty()) {
                ImGui::SeparatorText("Not assigned");
                for (const auto& r : s.assignment.unassigned) {
                    ImGui::BulletText("%s", r.name.c_str());
                }
            }
        }
        ImGui::EndTable();
    }

    ImGui::Spacing();
    char obuf[512];
    snprintf(obuf, sizeof(obuf), "%s", s.out_path.c_str());
    if (ImGui::InputText("crews.json out", obuf, sizeof(obuf))) s.out_path = obuf;

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
    if (!std::filesystem::exists(state.out_path)) {
        // find_existing falls back to the bare relative path; put crews.json
        // beside whatever attendance.json we actually found.
        std::filesystem::path p(state.in_path);
        p.replace_filename("crews.json");
        state.out_path = p.string();
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
