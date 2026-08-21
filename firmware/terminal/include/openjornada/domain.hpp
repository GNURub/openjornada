#pragma once

#include <cstdint>

namespace openjornada {

enum class WorkKind { Idle, Working, OnBreak };
enum class Command { ClockIn, BreakStart, BreakEnd, ClockOut };
enum class Button { A, B, C };

struct WorkState {
  WorkKind kind;
  int32_t workedSeconds;
  int32_t breakSeconds;
  bool longShift;
  bool staleBreak;
};

struct ButtonLabels {
  const char* a;
  const char* b;
  const char* c;
};

ButtonLabels visibleButtons(const WorkState& state);
WorkKind nextKind(WorkKind current, Command command);
int adjustedMinutes(int current, Button button, bool held);
bool offlineClockTrusted(int64_t syncedAt, int64_t now, bool rebooted);

}  // namespace openjornada
