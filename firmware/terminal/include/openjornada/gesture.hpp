#pragma once

#include <cstddef>
#include <cstdint>

namespace openjornada {

struct BootButtons {
  bool a = false;
  bool b = false;
  bool c = false;
};

enum class BootGesture {
  None,
  Provisioning,
  FactoryResetRequest,
  FactoryReset,
};

struct BootGestureEvent {
  BootGesture gesture = BootGesture::None;
  size_t pendingCount = 0;
};

class BootGestureDetector {
 public:
  explicit BootGestureDetector(size_t pendingCount = 0)
      : pendingCount_(pendingCount) {}

  BootGestureEvent update(BootButtons buttons, uint32_t elapsedMs);
  bool awaitingFactoryConfirmation() const;

 private:
  enum class State { BootCombos, AwaitFactoryRelease, ConfirmFactory };
  enum class Combo { None, AB, ABC };

  void resetCombo();
  void resetConfirmation();

  size_t pendingCount_ = 0;
  State state_ = State::BootCombos;
  bool comboTiming_ = false;
  Combo combo_ = Combo::None;
  uint32_t comboStartedMs_ = 0;
  bool confirmationTiming_ = false;
  uint32_t confirmationStartedMs_ = 0;
  bool provisioningEmitted_ = false;
};

}  // namespace openjornada
