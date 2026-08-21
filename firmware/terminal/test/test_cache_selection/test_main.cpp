#include <unity.h>

#include "openjornada/cache_store.hpp"

using namespace openjornada;

namespace {

void assertSelection(CacheSlot expectedSlot, bool expectedRepair,
                     CacheSelector selector, CacheSlotCandidate slotA,
                     CacheSlotCandidate slotB) {
  const CacheSelection selection = selectCacheSlot(selector, slotA, slotB);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(expectedSlot),
                        static_cast<int>(selection.slot));
  TEST_ASSERT_EQUAL(expectedRepair, selection.repairSelector);
}

}  // namespace

void test_no_valid_slot_returns_none() {
  assertSelection(CacheSlot::None, false, CacheSelector::Missing, {false, 0},
                  {false, 0});
  assertSelection(CacheSlot::None, false, CacheSelector::Corrupt, {false, 0},
                  {false, 0});
}

void test_only_valid_slot_is_selected_and_selector_is_repaired() {
  assertSelection(CacheSlot::A, true, CacheSelector::Missing, {true, 4},
                  {false, 0});
  assertSelection(CacheSlot::B, true, CacheSelector::Missing, {false, 0},
                  {true, 7});
  assertSelection(CacheSlot::A, true, CacheSelector::Corrupt, {true, 4},
                  {false, 0});
  assertSelection(CacheSlot::B, true, CacheSelector::Corrupt, {false, 0},
                  {true, 7});
  assertSelection(CacheSlot::B, true, CacheSelector::A, {false, 0},
                  {true, 7});
}

void test_newest_revision_wins_even_when_selector_points_to_older_slot() {
  assertSelection(CacheSlot::B, true, CacheSelector::A, {true, 10},
                  {true, 11});
  assertSelection(CacheSlot::A, true, CacheSelector::B, {true, 12},
                  {true, 11});
  assertSelection(CacheSlot::B, false, CacheSelector::B, {true, 11},
                  {true, 12});
  assertSelection(CacheSlot::B, true, CacheSelector::Missing, {true, 10},
                  {true, 11});
  assertSelection(CacheSlot::A, true, CacheSelector::Corrupt, {true, 12},
                  {true, 11});
}

void test_equal_revision_prefers_valid_selector() {
  assertSelection(CacheSlot::A, false, CacheSelector::A, {true, 9},
                  {true, 9});
  assertSelection(CacheSlot::B, false, CacheSelector::B, {true, 9},
                  {true, 9});
}

void test_equal_revision_without_selector_deterministically_uses_a() {
  assertSelection(CacheSlot::A, true, CacheSelector::Missing, {true, 9},
                  {true, 9});
  assertSelection(CacheSlot::A, true, CacheSelector::Corrupt, {true, 9},
                  {true, 9});
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_no_valid_slot_returns_none);
  RUN_TEST(test_only_valid_slot_is_selected_and_selector_is_repaired);
  RUN_TEST(test_newest_revision_wins_even_when_selector_points_to_older_slot);
  RUN_TEST(test_equal_revision_prefers_valid_selector);
  RUN_TEST(test_equal_revision_without_selector_deterministically_uses_a);
  return UNITY_END();
}
