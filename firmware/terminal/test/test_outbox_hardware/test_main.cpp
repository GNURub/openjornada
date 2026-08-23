#include <Arduino.h>
#include <LittleFS.h>
#include <unity.h>

#include <string>
#include <vector>

#include "openjornada/outbox.hpp"

using namespace openjornada;

namespace {

QueuedAction action(uint32_t sequence) {
  QueuedAction value;
  value.clientRequestId = "benchmark-" + std::to_string(sequence);
  value.uid = "04A1B2C3";
  value.command = Command::ClockIn;
  value.deviceCapturedAt = "2026-08-21T08:00:00Z";
  value.clockSyncedAt = "2026-08-21T08:00:00Z";
  value.deviceSequence = sequence;
  value.rebootId = "benchmark-boot";
  value.signature = std::string(64, 'a');
  return value;
}

void clearBenchmarkFiles(LittleFsOutboxStorage& storage) {
  (void)storage.remove(Outbox::kCurrentPath);
  (void)storage.remove(Outbox::kNewPath);
  (void)storage.remove(Outbox::kOldPath);
  (void)storage.remove(Outbox::kCompletionPath);
  (void)storage.remove(Outbox::kCompletionNewPath);
  (void)storage.remove(Outbox::kCompletionOldPath);
}

void test_full_journal_scans_yield_without_watchdog_reset() {
  LittleFsOutboxStorage storage;
  TEST_ASSERT_TRUE(storage.begin());
  clearBenchmarkFiles(storage);

  File journal = LittleFS.open(Outbox::kCurrentPath, "w");
  TEST_ASSERT_TRUE(journal);
  std::vector<uint8_t> encoded;
  const uint32_t populateStartedMs = millis();
  for (uint32_t sequence = 1; sequence <= OutboxCodec::kCapacity;
       ++sequence) {
    TEST_ASSERT_EQUAL(OutboxError::None,
                      OutboxCodec::encode(action(sequence), encoded));
    TEST_ASSERT_EQUAL_UINT(encoded.size(),
                           journal.write(encoded.data(), encoded.size()));
    if (sequence % 16U == 0) yield();
  }
  journal.flush();
  journal.close();
  const uint32_t populateMs = millis() - populateStartedMs;

  Outbox outbox(storage);
  const uint32_t beginStartedMs = millis();
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.begin());
  const uint32_t beginMs = millis() - beginStartedMs;

  size_t pending = 0;
  const uint32_t countStartedMs = millis();
  TEST_ASSERT_EQUAL(OutboxError::None, outbox.pendingCount(pending));
  const uint32_t countMs = millis() - countStartedMs;
  TEST_ASSERT_EQUAL_UINT(OutboxCodec::kCapacity, pending);

  const uint32_t appendStartedMs = millis();
  TEST_ASSERT_EQUAL(OutboxError::Capacity,
                    outbox.append(action(OutboxCodec::kCapacity + 1U)));
  const uint32_t appendMs = millis() - appendStartedMs;

  Serial.printf(
      "[OJ-BENCH] records=%u populate_ms=%lu begin_ms=%lu count_ms=%lu "
      "append_full_ms=%lu\n",
      static_cast<unsigned>(OutboxCodec::kCapacity),
      static_cast<unsigned long>(populateMs),
      static_cast<unsigned long>(beginMs),
      static_cast<unsigned long>(countMs),
      static_cast<unsigned long>(appendMs));
  clearBenchmarkFiles(storage);
  storage.end();
}

}  // namespace

void setup() {
  delay(2000);
  UNITY_BEGIN();
  RUN_TEST(test_full_journal_scans_yield_without_watchdog_reset);
  UNITY_END();
}

void loop() { delay(1000); }
