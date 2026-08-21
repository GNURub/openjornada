#include "openjornada/screen.hpp"

#ifdef ARDUINO

#include <M5Unified.h>

#include <array>
#include <ctime>

namespace openjornada {
namespace {

int displayTextWidth(std::string_view value) {
  const std::string owned(value);
  return M5.Display.textWidth(owned.c_str());
}

std::string fitted(std::string_view value, int maximumWidth,
                   std::string_view suffix = "...") {
  return fitUtf8ToWidth(value, maximumWidth, displayTextWidth, suffix);
}

std::string localClock(int64_t epochSeconds, bool date) {
  if (epochSeconds <= 0) return "--:--";
  const std::time_t raw = static_cast<std::time_t>(epochSeconds);
  std::tm local{};
  localtime_r(&raw, &local);
  std::array<char, 32> output{};
  const char* format = date ? "%d/%m  %H:%M" : "%H:%M";
  if (std::strftime(output.data(), output.size(), format, &local) == 0) {
    return "--:--";
  }
  return output.data();
}

std::string fingerprint(const ScreenState& state, int64_t nowEpochSeconds) {
  return std::to_string(static_cast<int>(state.kind)) + "|" + state.title +
         "|" + state.detail + "|" + state.employee + "|" + state.buttons.a +
         "|" + state.buttons.b + "|" + state.buttons.c + "|" +
         std::to_string(state.selectedEpochSeconds) + "|" +
         std::to_string(state.pendingCount) + "|" +
         std::to_string(state.networkConnected) + "|" +
         std::to_string(state.ntpTrusted) + "|" +
         std::to_string(state.warning) + "|" +
         std::to_string(state.busy) + "|" +
         std::to_string(state.kind == ScreenKind::Idle
                            ? nowEpochSeconds / 60
                            : 0);
}

void drawStatus(const ScreenState& state) {
  auto& display = M5.Display;
  display.setTextSize(1);
  display.setTextDatum(top_left);

  display.fillCircle(12, 11, 4,
                     state.networkConnected ? TFT_GREEN : TFT_RED);
  display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  display.drawString("Red", 20, 4);

  display.fillCircle(61, 11, 4,
                     state.ntpTrusted ? TFT_GREEN : TFT_ORANGE);
  display.drawString("Hora", 69, 4);

  display.fillCircle(121, 11, 4,
                     state.pendingCount == 0 ? TFT_DARKGREEN : TFT_ORANGE);
  const std::string pending = "Pend: " + std::to_string(state.pendingCount);
  display.drawString(fitted(pending, 183).c_str(), 129, 4);
  display.drawFastHLine(8, 25, 304, TFT_DARKGREY);
}

void drawButtons(const ScreenButtons& buttons) {
  auto& display = M5.Display;
  constexpr int y = 203;
  constexpr int width = 104;
  const std::array<std::string, 3> labels{buttons.a, buttons.b, buttons.c};
  constexpr std::array<char, 3> names{'A', 'B', 'C'};
  for (size_t index = 0; index < labels.size(); ++index) {
    const int x = static_cast<int>(index) * 107;
    const bool active = !labels[index].empty();
    display.fillRoundRect(x + 2, y, width, 33, 5,
                          active ? TFT_DARKGREY : TFT_BLACK);
    display.drawRoundRect(x + 2, y, width, 33, 5,
                          active ? TFT_LIGHTGREY : TFT_DARKGREY);
    display.setTextDatum(middle_center);
    display.setTextSize(1);
    display.setTextColor(active ? TFT_WHITE : TFT_DARKGREY,
                         active ? TFT_DARKGREY : TFT_BLACK);
    const std::string name(1, names[index]);
    display.drawString(name.c_str(), x + 54, active ? y + 9 : y + 17);
    if (active) {
      display.drawString(fitted(labels[index], width - 8).c_str(), x + 54,
                         y + 23);
    }
  }
}

void drawTwoLineDetail(const std::string& detail, uint16_t color, int y) {
  auto& display = M5.Display;
  display.setTextDatum(top_left);
  display.setTextSize(1);
  display.setTextColor(color, TFT_BLACK);
  constexpr int maximumWidth = 292;
  const std::string firstFit = fitted(detail, maximumWidth, "");
  if (firstFit.size() == detail.size()) {
    display.drawString(firstFit.c_str(), 14, y);
    return;
  }

  size_t split = firstFit.rfind(' ');
  if (split == std::string::npos || split == 0) split = firstFit.size();
  display.drawString(firstFit.substr(0, split).c_str(), 14, y);
  size_t second = split;
  while (second < detail.size() && detail[second] == ' ') ++second;
  display.drawString(fitted(std::string_view(detail).substr(second),
                            maximumWidth)
                         .c_str(),
                     14, y + 20);
}

}  // namespace

void ScreenRenderer::render(const ScreenState& state,
                            int64_t nowEpochSeconds) {
  const std::string nextFingerprint = fingerprint(state, nowEpochSeconds);
  if (nextFingerprint == lastFingerprint_) return;
  lastFingerprint_ = nextFingerprint;

  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  drawStatus(state);

  display.setTextDatum(top_left);
  display.setTextColor(state.warning ? TFT_ORANGE : TFT_YELLOW, TFT_BLACK);
  display.setTextSize(state.kind == ScreenKind::TimePicker ? 1 : 2);
  display.drawString(fitted(state.title, 296).c_str(), 12, 35);

  if (state.kind == ScreenKind::Idle) {
    display.setTextDatum(middle_center);
    display.setTextColor(TFT_WHITE, TFT_BLACK);
    display.setTextSize(3);
    display.drawString(localClock(nowEpochSeconds, false).c_str(), 160, 100);
    display.setTextSize(1);
    display.setTextColor(TFT_CYAN, TFT_BLACK);
    display.drawString("Acerca tu tarjeta", 160, 153);
  } else if (state.kind == ScreenKind::TimePicker) {
    display.setTextDatum(middle_center);
    display.setTextColor(TFT_WHITE, TFT_BLACK);
    display.setTextSize(3);
    display.drawString(localClock(state.selectedEpochSeconds, false).c_str(),
                       160, 105);
    display.setTextSize(1);
    display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    display.drawString(localClock(state.selectedEpochSeconds, true).c_str(),
                       160, 142);
    display.setTextColor(TFT_CYAN, TFT_BLACK);
    display.drawString(fitted(state.detail, 296).c_str(), 160, 170);
  } else {
    if (!state.employee.empty() && state.employee != state.title) {
      display.setTextSize(1);
      display.setTextColor(TFT_CYAN, TFT_BLACK);
      display.drawString(fitted(state.employee, 292).c_str(), 14, 70);
    }
    drawTwoLineDetail(state.detail,
                      state.warning ? TFT_ORANGE : TFT_WHITE, 91);
    if (state.busy) {
      display.setTextColor(TFT_CYAN, TFT_BLACK);
      display.drawString("Procesando...", 14, 158);
    }
  }

  drawButtons(state.buttons);
}

}  // namespace openjornada

#endif
