#pragma once

#include <cstdint>

namespace openjornada {

class ClockTrust {
 public:
  static constexpr int64_t kMaximumOfflineAgeSeconds = 24 * 60 * 60;

  explicit ClockTrust(int64_t persistedNtpEpochSeconds = 0);

  void onBoot();
  bool onNtpSync(int64_t epochSeconds);
  bool canCreateOffline(int64_t nowEpochSeconds) const;
  bool canSyncQueued() const { return true; }
  bool synchronizedThisBoot() const { return synchronizedThisBoot_; }
  int64_t lastNtpEpochSeconds() const { return lastNtpEpochSeconds_; }

 private:
  int64_t lastNtpEpochSeconds_ = 0;
  bool synchronizedThisBoot_ = false;
};

}  // namespace openjornada
