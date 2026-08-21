#pragma once

#include <cstdint>
#include <string>

#include "openjornada/api_models.hpp"
#include "openjornada/url_policy.hpp"

namespace openjornada {

struct ApiCredentials {
  std::string baseUrl;
  std::string terminalToken;
};

struct ApiCallResult {
  bool ok = true;
  ApiFailure failure;
};

class ApiClient {
 public:
  virtual ~ApiClient() = default;

  virtual ApiCallResult bootstrap(const ApiCredentials& credentials,
                                  const BootstrapRequest& request,
                                  BootstrapResponse& output,
                                  uint32_t timeoutMs) = 0;
  virtual ApiCallResult resolve(const ApiCredentials& credentials,
                                const std::string& uid,
                                ResolveResponse& output,
                                uint32_t timeoutMs) = 0;
  virtual ApiCallResult action(const ApiCredentials& credentials,
                               const ActionRequest& request,
                               ActionResult& output,
                               uint32_t timeoutMs) = 0;
  virtual ApiCallResult cache(const ApiCredentials& credentials,
                              uint32_t revision, CacheResponse& output,
                              uint32_t timeoutMs) = 0;
  virtual ApiCallResult openAdminSession(const ApiCredentials& credentials,
                                         const std::string& pin,
                                         AdminSessionResponse& output,
                                         uint32_t timeoutMs) = 0;
  virtual ApiCallResult closeAdminSession(const ApiCredentials& credentials,
                                          const std::string& adminSession,
                                          uint32_t timeoutMs) = 0;
  virtual ApiCallResult employees(const ApiCredentials& credentials,
                                  const std::string& adminSession,
                                  EmployeeListResponse& output,
                                  uint32_t timeoutMs) = 0;
  virtual ApiCallResult assignEmployee(const ApiCredentials& credentials,
                                       const std::string& adminSession,
                                       const std::string& employeeId,
                                       const std::string& uid, bool replace,
                                       uint32_t timeoutMs) = 0;
  virtual ApiCallResult revokeEmployee(const ApiCredentials& credentials,
                                       const std::string& adminSession,
                                       const std::string& employeeId,
                                       uint32_t timeoutMs) = 0;
  virtual ApiCallResult sync(const ApiCredentials& credentials,
                             const SyncRequest& request,
                             SyncResponse& output,
                             uint32_t timeoutMs) = 0;
};

#ifdef ARDUINO
class Esp32ApiClient final : public ApiClient {
 public:
  explicit Esp32ApiClient(BuildProfile profile) : profile_(profile) {}

  ApiCallResult bootstrap(const ApiCredentials&, const BootstrapRequest&,
                          BootstrapResponse&, uint32_t) override;
  ApiCallResult resolve(const ApiCredentials&, const std::string&,
                        ResolveResponse&, uint32_t) override;
  ApiCallResult action(const ApiCredentials&, const ActionRequest&,
                       ActionResult&, uint32_t) override;
  ApiCallResult cache(const ApiCredentials&, uint32_t, CacheResponse&,
                      uint32_t) override;
  ApiCallResult openAdminSession(const ApiCredentials&, const std::string&,
                                 AdminSessionResponse&, uint32_t) override;
  ApiCallResult closeAdminSession(const ApiCredentials&, const std::string&,
                                  uint32_t) override;
  ApiCallResult employees(const ApiCredentials&, const std::string&,
                          EmployeeListResponse&, uint32_t) override;
  ApiCallResult assignEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, const std::string&, bool,
                               uint32_t) override;
  ApiCallResult revokeEmployee(const ApiCredentials&, const std::string&,
                               const std::string&, uint32_t) override;
  ApiCallResult sync(const ApiCredentials&, const SyncRequest&, SyncResponse&,
                     uint32_t) override;

 private:
  BuildProfile profile_;
};
#endif

}  // namespace openjornada
