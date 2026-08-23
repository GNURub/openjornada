#include "openjornada/clock_trust.hpp"

namespace openjornada {

ClockTrust::ClockTrust(int64_t persistedNtpEpochSeconds)
    : lastNtpEpochSeconds_(persistedNtpEpochSeconds > 0
                              ? persistedNtpEpochSeconds
                              : 0) {}

void ClockTrust::onBoot() { synchronizedThisBoot_ = false; }

bool ClockTrust::onNtpSync(int64_t epochSeconds) {
  if (epochSeconds <= 0) return false;
  if (epochSeconds < lastNtpEpochSeconds_) return false;
  lastNtpEpochSeconds_ = epochSeconds;
  synchronizedThisBoot_ = true;
  return true;
}

bool ClockTrust::canCreateOffline(int64_t nowEpochSeconds) const {
  return synchronizedThisBoot_ && lastNtpEpochSeconds_ > 0 &&
         nowEpochSeconds >= lastNtpEpochSeconds_ &&
         nowEpochSeconds - lastNtpEpochSeconds_ <=
             kMaximumOfflineAgeSeconds;
}

}  // namespace openjornada
