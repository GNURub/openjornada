#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace openjornada {

// A single monotonic deadline shared by DNS/connect/TLS/write/read. Unsigned
// subtraction keeps normal millis() wrap-around safe for these short budgets.
class RequestDeadline {
 public:
  RequestDeadline(uint32_t startedAtMs, uint32_t budgetMs)
      : startedAtMs_(startedAtMs), budgetMs_(budgetMs) {}

  bool expired(uint32_t nowMs) const;
  uint32_t remaining(uint32_t nowMs) const;

 private:
  uint32_t startedAtMs_;
  uint32_t budgetMs_;
};

enum class HttpParseStatus {
  NeedMore,
  Complete,
  Invalid,
  HeaderTooLarge,
  BodyTooLarge,
};

struct ParsedHttpResponse {
  int status = 0;
  std::string body;
};

// Incremental HTTP/1.x response parser with fixed header/trailer limits and a
// caller-selected body cap. It supports Content-Length, chunked transfer and
// connection-close framing without owning a socket or a clock.
class BoundedHttpResponseParser {
 public:
  static constexpr size_t kMaxHeaderBytes = 4096;
  static constexpr size_t kMaxTrailerBytes = 1024;
  static constexpr size_t kMaxChunkLineBytes = 128;

  explicit BoundedHttpResponseParser(size_t maxBodyBytes);

  HttpParseStatus consume(char byte);
  HttpParseStatus finishOnDisconnect();
  HttpParseStatus status() const { return status_; }
  const ParsedHttpResponse& response() const { return response_; }

 private:
  enum class State {
    Headers,
    FixedBody,
    UntilClose,
    ChunkSize,
    ChunkData,
    ChunkDataCr,
    ChunkDataLf,
    Trailers,
    Done,
    Failed,
  };

  HttpParseStatus fail(HttpParseStatus status);
  bool appendBody(char byte);
  HttpParseStatus parseHeaders();
  HttpParseStatus finishLine(bool trailer);

  size_t maxBodyBytes_;
  State state_ = State::Headers;
  HttpParseStatus status_ = HttpParseStatus::NeedMore;
  ParsedHttpResponse response_;
  std::string header_;
  std::string line_;
  size_t fixedRemaining_ = 0;
  size_t chunkRemaining_ = 0;
  size_t trailerBytes_ = 0;
  bool lineSawCr_ = false;
};

}  // namespace openjornada
