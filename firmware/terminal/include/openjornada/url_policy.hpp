#pragma once

#include <cstddef>
#include <string_view>

namespace openjornada {

enum class BuildProfile { Development, Release };

enum class UrlError {
  None,
  Empty,
  TooLong,
  InvalidScheme,
  InvalidAuthority,
  Credentials,
  InvalidHost,
  Loopback,
  InvalidPort,
  PrivateHttpRequired,
  InvalidPath,
  Query,
  Fragment,
};

struct UrlDecision {
  bool allowed;
  UrlError error;
};

constexpr size_t kMaxBaseUrlBytes = 255;

UrlDecision validateBaseUrl(std::string_view url, BuildProfile profile);
BuildProfile currentBuildProfile();

}  // namespace openjornada
