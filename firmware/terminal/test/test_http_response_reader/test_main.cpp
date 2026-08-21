#include <unity.h>

#include <cstdint>
#include <string>

#include "openjornada/http_response_reader.hpp"

using namespace openjornada;

namespace {

HttpParseStatus feed(BoundedHttpResponseParser& parser,
                     const std::string& bytes) {
  HttpParseStatus status = HttpParseStatus::NeedMore;
  for (char byte : bytes) {
    status = parser.consume(byte);
    if (status != HttpParseStatus::NeedMore) break;
  }
  return status;
}

void test_deadline_is_absolute_and_wrap_safe() {
  RequestDeadline deadline(1000U, 10000U);
  TEST_ASSERT_EQUAL_UINT32(10000, deadline.remaining(1000U));
  TEST_ASSERT_EQUAL_UINT32(6000, deadline.remaining(5000U));
  TEST_ASSERT_EQUAL_UINT32(1, deadline.remaining(10999U));
  TEST_ASSERT_EQUAL_UINT32(0, deadline.remaining(11000U));
  TEST_ASSERT_TRUE(deadline.expired(12000U));

  RequestDeadline wrapped(0xFFFFFFF0U, 32U);
  TEST_ASSERT_EQUAL_UINT32(16, wrapped.remaining(0U));
  TEST_ASSERT_TRUE(wrapped.expired(0x10U));
}

void test_content_length_response_is_bounded() {
  BoundedHttpResponseParser parser(5);
  TEST_ASSERT_EQUAL(HttpParseStatus::Complete,
                    feed(parser, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"));
  TEST_ASSERT_EQUAL_INT(200, parser.response().status);
  TEST_ASSERT_EQUAL_STRING("hello", parser.response().body.c_str());

  BoundedHttpResponseParser tooLarge(4);
  TEST_ASSERT_EQUAL(HttpParseStatus::BodyTooLarge,
                    feed(tooLarge,
                         "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n"));
}

void test_chunked_response_accepts_fragmented_stream() {
  BoundedHttpResponseParser parser(16);
  TEST_ASSERT_EQUAL(HttpParseStatus::NeedMore,
                    feed(parser, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWi"));
  TEST_ASSERT_EQUAL(HttpParseStatus::NeedMore, feed(parser, "ki\r\n5\r\nped"));
  TEST_ASSERT_EQUAL(HttpParseStatus::Complete,
                    feed(parser, "ia\r\n0\r\nX-Trace: ignored\r\n\r\n"));
  TEST_ASSERT_EQUAL_STRING("Wikipedia", parser.response().body.c_str());
}

void test_ambiguous_or_malformed_framing_is_rejected() {
  BoundedHttpResponseParser ambiguous(32);
  TEST_ASSERT_EQUAL(HttpParseStatus::Invalid,
                    feed(ambiguous,
                         "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n"));

  BoundedHttpResponseParser duplicate(32);
  TEST_ASSERT_EQUAL(HttpParseStatus::Invalid,
                    feed(duplicate,
                         "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n"));

  BoundedHttpResponseParser badChunk(32);
  TEST_ASSERT_EQUAL(HttpParseStatus::Invalid,
                    feed(badChunk,
                         "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nGG\r\n"));
}

void test_close_delimited_response_completes_only_on_disconnect() {
  BoundedHttpResponseParser parser(8);
  TEST_ASSERT_EQUAL(HttpParseStatus::NeedMore,
                    feed(parser, "HTTP/1.0 503 Error\r\nConnection: close\r\n\r\nerror"));
  TEST_ASSERT_EQUAL(HttpParseStatus::Complete, parser.finishOnDisconnect());
  TEST_ASSERT_EQUAL_INT(503, parser.response().status);

  BoundedHttpResponseParser incomplete(8);
  TEST_ASSERT_EQUAL(HttpParseStatus::NeedMore,
                    feed(incomplete,
                         "HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nshort"));
  TEST_ASSERT_EQUAL(HttpParseStatus::Invalid,
                    incomplete.finishOnDisconnect());
}

void test_header_and_trickle_do_not_extend_deadline() {
  RequestDeadline deadline(100U, 1000U);
  BoundedHttpResponseParser parser(64);
  const std::string trickle = "HTTP/1.1 200 OK\r\n";
  uint32_t now = 100U;
  for (char byte : trickle) {
    TEST_ASSERT_FALSE(deadline.expired(now));
    TEST_ASSERT_EQUAL(HttpParseStatus::NeedMore, parser.consume(byte));
    now += 60U;
  }
  TEST_ASSERT_TRUE(deadline.expired(now));
  TEST_ASSERT_EQUAL_UINT32(0, deadline.remaining(now));
}

}  // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_deadline_is_absolute_and_wrap_safe);
  RUN_TEST(test_content_length_response_is_bounded);
  RUN_TEST(test_chunked_response_accepts_fragmented_stream);
  RUN_TEST(test_ambiguous_or_malformed_framing_is_rejected);
  RUN_TEST(test_close_delimited_response_completes_only_on_disconnect);
  RUN_TEST(test_header_and_trickle_do_not_extend_deadline);
  return UNITY_END();
}
