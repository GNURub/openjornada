#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace openjornada {

enum class ScreenKind {
  Boot,
  Idle,
  Message,
  Actions,
  TimePicker,
  CloseConfirm,
  AdminPin,
  AdminEmployees,
  AdminScan,
  Provisioning,
  Fatal,
};

struct ScreenButtons {
  std::string a;
  std::string b;
  std::string c;
};

struct ScreenState {
  ScreenKind kind = ScreenKind::Boot;
  std::string title;
  std::string detail;
  std::string employee;
  ScreenButtons buttons;
  uint32_t deadlineMs = 0;
  int64_t selectedEpochSeconds = 0;
  size_t pendingCount = 0;
  bool networkConnected = false;
  bool ntpTrusted = false;
  bool warning = false;
  bool busy = false;
};

using TextWidthMeasure = std::function<int(std::string_view)>;

bool validUtf8(std::string_view value);
std::string fitUtf8ToWidth(std::string_view value, int maximumWidth,
                           const TextWidthMeasure& measure,
                           std::string_view suffix = "...");

#ifdef ARDUINO
class ScreenRenderer {
 public:
  void render(const ScreenState& state, int64_t nowEpochSeconds);

 private:
  std::string lastFingerprint_;
};
#endif

}  // namespace openjornada
