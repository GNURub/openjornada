#include "openjornada/http_response_reader.hpp"

#include <algorithm>
#include <cctype>
#include <limits>
#include <string_view>

namespace openjornada {
namespace {

std::string_view trim(std::string_view value) {
  while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
    value.remove_prefix(1);
  }
  while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) {
    value.remove_suffix(1);
  }
  return value;
}

bool decimalSize(std::string_view value, size_t& output) {
  value = trim(value);
  if (value.empty()) return false;
  size_t parsed = 0;
  for (const unsigned char byte : value) {
    if (!std::isdigit(byte)) return false;
    const size_t digit = byte - '0';
    if (parsed > (std::numeric_limits<size_t>::max() - digit) / 10U) {
      return false;
    }
    parsed = parsed * 10U + digit;
  }
  output = parsed;
  return true;
}

bool hexSize(std::string_view value, size_t& output) {
  const size_t extension = value.find(';');
  const std::string_view raw = trim(value.substr(0, extension));
  if (raw.empty()) return false;
  size_t parsed = 0;
  for (const unsigned char byte : raw) {
    size_t digit = 0;
    if (byte >= '0' && byte <= '9') digit = byte - '0';
    else if (byte >= 'a' && byte <= 'f') digit = byte - 'a' + 10U;
    else if (byte >= 'A' && byte <= 'F') digit = byte - 'A' + 10U;
    else return false;
    if (parsed > (std::numeric_limits<size_t>::max() - digit) / 16U) {
      return false;
    }
    parsed = parsed * 16U + digit;
  }
  if (extension != std::string_view::npos) {
    const auto suffix = value.substr(extension + 1U);
    if (suffix.empty() || std::any_of(suffix.begin(), suffix.end(),
                                     [](unsigned char byte) {
                                       return byte < 0x20U || byte >= 0x7FU;
                                     })) {
      return false;
    }
  }
  output = parsed;
  return true;
}

std::string lower(std::string_view value) {
  std::string output(value);
  std::transform(output.begin(), output.end(), output.begin(),
                 [](unsigned char byte) {
                   return static_cast<char>(std::tolower(byte));
                 });
  return output;
}

}  // namespace

bool RequestDeadline::expired(uint32_t nowMs) const {
  return static_cast<uint32_t>(nowMs - startedAtMs_) >= budgetMs_;
}

uint32_t RequestDeadline::remaining(uint32_t nowMs) const {
  const uint32_t elapsed = static_cast<uint32_t>(nowMs - startedAtMs_);
  return elapsed >= budgetMs_ ? 0U : budgetMs_ - elapsed;
}

BoundedHttpResponseParser::BoundedHttpResponseParser(size_t maxBodyBytes)
    : maxBodyBytes_(maxBodyBytes) {
  header_.reserve(std::min(maxBodyBytes, kMaxHeaderBytes));
  response_.body.reserve(std::min<size_t>(maxBodyBytes, 4096U));
}

HttpParseStatus BoundedHttpResponseParser::fail(HttpParseStatus status) {
  state_ = State::Failed;
  status_ = status;
  return status_;
}

bool BoundedHttpResponseParser::appendBody(char byte) {
  if (response_.body.size() >= maxBodyBytes_) return false;
  response_.body.push_back(byte);
  return true;
}

HttpParseStatus BoundedHttpResponseParser::parseHeaders() {
  if (header_.size() < 4U) return fail(HttpParseStatus::Invalid);
  const std::string_view headers(header_.data(), header_.size() - 4U);
  size_t cursor = 0;
  const size_t firstEnd = headers.find("\r\n");
  const std::string_view statusLine =
      firstEnd == std::string_view::npos ? headers : headers.substr(0, firstEnd);
  if (statusLine.rfind("HTTP/1.1 ", 0) != 0 &&
      statusLine.rfind("HTTP/1.0 ", 0) != 0) {
    return fail(HttpParseStatus::Invalid);
  }
  const size_t codeAt = 9U;
  if (statusLine.size() < codeAt + 3U ||
      !std::isdigit(static_cast<unsigned char>(statusLine[codeAt])) ||
      !std::isdigit(static_cast<unsigned char>(statusLine[codeAt + 1U])) ||
      !std::isdigit(static_cast<unsigned char>(statusLine[codeAt + 2U]))) {
    return fail(HttpParseStatus::Invalid);
  }
  response_.status = (statusLine[codeAt] - '0') * 100 +
                     (statusLine[codeAt + 1U] - '0') * 10 +
                     (statusLine[codeAt + 2U] - '0');
  if (response_.status < 100 || response_.status > 599 ||
      (response_.status >= 100 && response_.status < 200)) {
    return fail(HttpParseStatus::Invalid);
  }

  bool hasLength = false;
  bool hasTransferEncoding = false;
  size_t contentLength = 0;
  cursor = firstEnd == std::string_view::npos ? headers.size() : firstEnd + 2U;
  while (cursor < headers.size()) {
    const size_t end = headers.find("\r\n", cursor);
    const size_t lineEnd =
        end == std::string_view::npos ? headers.size() : end;
    const std::string_view line = headers.substr(cursor, lineEnd - cursor);
    const size_t colon = line.find(':');
    if (colon == std::string_view::npos || colon == 0U) {
      return fail(HttpParseStatus::Invalid);
    }
    const std::string name = lower(trim(line.substr(0, colon)));
    const std::string_view value = trim(line.substr(colon + 1U));
    if (name == "content-length") {
      if (hasLength || !decimalSize(value, contentLength)) {
        return fail(HttpParseStatus::Invalid);
      }
      hasLength = true;
    } else if (name == "transfer-encoding") {
      if (hasTransferEncoding || lower(value) != "chunked") {
        return fail(HttpParseStatus::Invalid);
      }
      hasTransferEncoding = true;
    }
    cursor = lineEnd == headers.size() ? headers.size() : lineEnd + 2U;
  }
  if (hasLength && hasTransferEncoding) return fail(HttpParseStatus::Invalid);
  if (hasLength && contentLength > maxBodyBytes_) {
    return fail(HttpParseStatus::BodyTooLarge);
  }
  if (response_.status == 204 || response_.status == 304 ||
      (hasLength && contentLength == 0U)) {
    state_ = State::Done;
    status_ = HttpParseStatus::Complete;
  } else if (hasTransferEncoding) {
    state_ = State::ChunkSize;
  } else if (hasLength) {
    fixedRemaining_ = contentLength;
    state_ = State::FixedBody;
  } else {
    state_ = State::UntilClose;
  }
  return status_;
}

HttpParseStatus BoundedHttpResponseParser::finishLine(bool trailer) {
  lineSawCr_ = false;
  if (trailer) {
    if (line_.empty()) {
      state_ = State::Done;
      status_ = HttpParseStatus::Complete;
    }
    line_.clear();
    return status_;
  }
  size_t chunkSize = 0;
  if (!hexSize(line_, chunkSize) ||
      chunkSize > maxBodyBytes_ - response_.body.size()) {
    line_.clear();
    return fail(chunkSize > maxBodyBytes_ - response_.body.size()
                    ? HttpParseStatus::BodyTooLarge
                    : HttpParseStatus::Invalid);
  }
  line_.clear();
  chunkRemaining_ = chunkSize;
  state_ = chunkSize == 0U ? State::Trailers : State::ChunkData;
  return status_;
}

HttpParseStatus BoundedHttpResponseParser::consume(char byte) {
  if (status_ != HttpParseStatus::NeedMore) return status_;
  switch (state_) {
    case State::Headers:
      if (header_.size() >= kMaxHeaderBytes) {
        return fail(HttpParseStatus::HeaderTooLarge);
      }
      header_.push_back(byte);
      if (header_.size() >= 4U &&
          header_.compare(header_.size() - 4U, 4U, "\r\n\r\n") == 0) {
        return parseHeaders();
      }
      break;
    case State::FixedBody:
      if (!appendBody(byte)) return fail(HttpParseStatus::BodyTooLarge);
      if (--fixedRemaining_ == 0U) {
        state_ = State::Done;
        status_ = HttpParseStatus::Complete;
      }
      break;
    case State::UntilClose:
      if (!appendBody(byte)) return fail(HttpParseStatus::BodyTooLarge);
      break;
    case State::ChunkSize:
    case State::Trailers: {
      const bool trailer = state_ == State::Trailers;
      if (trailer && ++trailerBytes_ > kMaxTrailerBytes) {
        return fail(HttpParseStatus::HeaderTooLarge);
      }
      if (lineSawCr_) {
        if (byte != '\n') return fail(HttpParseStatus::Invalid);
        return finishLine(trailer);
      }
      if (byte == '\r') {
        lineSawCr_ = true;
      } else {
        if (byte == '\n' || line_.size() >= kMaxChunkLineBytes ||
            static_cast<unsigned char>(byte) < 0x20U) {
          return fail(HttpParseStatus::Invalid);
        }
        line_.push_back(byte);
      }
      break;
    }
    case State::ChunkData:
      if (!appendBody(byte)) return fail(HttpParseStatus::BodyTooLarge);
      if (--chunkRemaining_ == 0U) state_ = State::ChunkDataCr;
      break;
    case State::ChunkDataCr:
      if (byte != '\r') return fail(HttpParseStatus::Invalid);
      state_ = State::ChunkDataLf;
      break;
    case State::ChunkDataLf:
      if (byte != '\n') return fail(HttpParseStatus::Invalid);
      state_ = State::ChunkSize;
      break;
    case State::Done:
    case State::Failed:
      return status_;
  }
  return status_;
}

HttpParseStatus BoundedHttpResponseParser::finishOnDisconnect() {
  if (status_ != HttpParseStatus::NeedMore) return status_;
  if (state_ == State::UntilClose) {
    state_ = State::Done;
    status_ = HttpParseStatus::Complete;
    return status_;
  }
  return fail(HttpParseStatus::Invalid);
}

}  // namespace openjornada
