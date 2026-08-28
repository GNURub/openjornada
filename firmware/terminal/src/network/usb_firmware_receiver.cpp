#include "openjornada/usb_firmware_receiver.hpp"

#include <algorithm>
#include <array>
#include <new>
#include <string>
#include <utility>

#ifdef ARDUINO
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#endif

namespace openjornada {

UsbFirmwareDecision decideUsbFirmwareInstall(
    const UsbFirmwareContext& context) {
  if (context.pendingCount != 0U) {
    return UsbFirmwareDecision::RejectPendingActions;
  }
  if (context.transferActive) return UsbFirmwareDecision::RejectDuplicate;
  if (!context.runtimeIdle) return UsbFirmwareDecision::RejectBusy;
  if (!context.boardCompatible) return UsbFirmwareDecision::RejectBoard;
  if (!context.protocolCompatible) return UsbFirmwareDecision::RejectProtocol;
  if (context.imageSize == 0U || context.slotSize == 0U ||
      context.imageSize > context.slotSize) {
    return UsbFirmwareDecision::RejectSize;
  }
  if (context.official) {
    return context.signatureValid ? UsbFirmwareDecision::Accept
                                  : UsbFirmwareDecision::RejectSignature;
  }
  return context.physicallyConfirmed
             ? UsbFirmwareDecision::Accept
             : UsbFirmwareDecision::RequirePhysicalConfirmation;
}

const char* usbFirmwareDecisionCode(UsbFirmwareDecision decision) {
  switch (decision) {
    case UsbFirmwareDecision::Accept: return "accepted";
    case UsbFirmwareDecision::RequirePhysicalConfirmation:
      return "physical_confirmation_required";
    case UsbFirmwareDecision::RejectPendingActions: return "pending_actions";
    case UsbFirmwareDecision::RejectBusy: return "busy";
    case UsbFirmwareDecision::RejectBoard: return "wrong_board";
    case UsbFirmwareDecision::RejectProtocol: return "wrong_protocol";
    case UsbFirmwareDecision::RejectSignature: return "invalid_signature";
    case UsbFirmwareDecision::RejectSize: return "invalid_size";
    case UsbFirmwareDecision::RejectFlash: return "flash";
    case UsbFirmwareDecision::RejectDuplicate: return "duplicate_begin";
  }
  return "firmware_rejected";
}

bool officialUsbFirmwareIntentValid(
    const FirmwareTransferIntent& intent, std::string_view currentVersion,
    const std::array<uint8_t, 32>& publicKey) {
  if (!intent.official || intent.manifest.empty() || intent.signature.empty()) {
    return false;
  }
  FirmwareManifest manifest;
  if (!verifyFirmwareManifestSignature(intent.manifest, intent.signature,
                                       publicKey, manifest) ||
      !manifestIsInstallable(manifest, currentVersion,
                             intent.metadata.protocolVersion)) {
    return false;
  }
  return manifest.size == intent.size && manifest.sha256 == intent.sha256 &&
         manifest.firmwareVersion == intent.metadata.firmwareVersion &&
         manifest.board == intent.metadata.board &&
         manifest.protocolVersion == intent.metadata.protocolVersion;
}

FirmwareUpdateError finalizeOtaCandidate(
    FirmwareSlotWriter& writer, OtaCommitStore& store,
    const std::string& version, const std::string& hash,
    int64_t checkedAtEpochSeconds) {
  if (!store.stageCandidate(version, hash, checkedAtEpochSeconds)) {
    writer.abort();
    (void)store.clearPending();
    return FirmwareUpdateError::BootValidation;
  }
  if (!writer.finish()) {
    writer.abort();
    (void)store.clearPending();
    return FirmwareUpdateError::Flash;
  }
  if (!store.markBootPending()) {
    // finish() selected the candidate; abort() must restore the running slot.
    writer.abort();
    (void)store.clearPending();
    return FirmwareUpdateError::BootValidation;
  }
  return FirmwareUpdateError::None;
}

namespace {

std::string lowerHex(const std::array<uint8_t, 32>& bytes) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string output(bytes.size() * 2U, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    output[index * 2U] = alphabet[bytes[index] >> 4U];
    output[index * 2U + 1U] = alphabet[bytes[index] & 0x0fU];
  }
  return output;
}

#ifndef ARDUINO
uint32_t rotateRight(uint32_t value, unsigned count) {
  return (value >> count) | (value << (32U - count));
}
#endif

}  // namespace

class UsbFirmwareReceiver::HashState {
 public:
  HashState() {
#ifdef ARDUINO
    mbedtls_sha256_init(&context_);
    valid_ = mbedtls_sha256_starts_ret(&context_, 0) == 0;
#else
    reset();
#endif
  }

  ~HashState() {
#ifdef ARDUINO
    mbedtls_sha256_free(&context_);
#endif
  }

  bool valid() const { return valid_; }

  bool update(const uint8_t* data, size_t length) {
    if (!valid_ || data == nullptr || length == 0U) return length == 0U;
#ifdef ARDUINO
    valid_ = mbedtls_sha256_update_ret(&context_, data, length) == 0;
#else
    for (size_t index = 0; index < length; ++index) {
      buffer_[bufferLength_++] = data[index];
      if (bufferLength_ == buffer_.size()) {
        transform(buffer_.data());
        bitLength_ += 512U;
        bufferLength_ = 0;
      }
    }
#endif
    return valid_;
  }

  bool finish(std::array<uint8_t, 32>& digest) {
    if (!valid_) return false;
#ifdef ARDUINO
    valid_ = mbedtls_sha256_finish_ret(&context_, digest.data()) == 0;
    return valid_;
#else
    bitLength_ += static_cast<uint64_t>(bufferLength_) * 8U;
    buffer_[bufferLength_++] = 0x80U;
    if (bufferLength_ > 56U) {
      while (bufferLength_ < 64U) buffer_[bufferLength_++] = 0;
      transform(buffer_.data());
      bufferLength_ = 0;
    }
    while (bufferLength_ < 56U) buffer_[bufferLength_++] = 0;
    for (size_t index = 0; index < 8U; ++index) {
      buffer_[63U - index] =
          static_cast<uint8_t>(bitLength_ >> (index * 8U));
    }
    transform(buffer_.data());
    for (size_t word = 0; word < state_.size(); ++word) {
      for (size_t byte = 0; byte < 4U; ++byte) {
        digest[word * 4U + byte] = static_cast<uint8_t>(
            state_[word] >> (24U - static_cast<unsigned>(byte) * 8U));
      }
    }
    return true;
#endif
  }

 private:
#ifndef ARDUINO
  void reset() {
    state_ = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
              0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  }

  void transform(const uint8_t* block) {
    static constexpr std::array<uint32_t, 64> constants{
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
        0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
        0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
        0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
        0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
        0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
        0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
        0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
        0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};
    std::array<uint32_t, 64> words{};
    for (size_t index = 0; index < 16U; ++index) {
      words[index] = static_cast<uint32_t>(block[index * 4U]) << 24U |
                     static_cast<uint32_t>(block[index * 4U + 1U]) << 16U |
                     static_cast<uint32_t>(block[index * 4U + 2U]) << 8U |
                     static_cast<uint32_t>(block[index * 4U + 3U]);
    }
    for (size_t index = 16U; index < words.size(); ++index) {
      const uint32_t s0 = rotateRight(words[index - 15U], 7U) ^
                          rotateRight(words[index - 15U], 18U) ^
                          (words[index - 15U] >> 3U);
      const uint32_t s1 = rotateRight(words[index - 2U], 17U) ^
                          rotateRight(words[index - 2U], 19U) ^
                          (words[index - 2U] >> 10U);
      words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (size_t index = 0; index < words.size(); ++index) {
      const uint32_t sum1 = rotateRight(e, 6U) ^ rotateRight(e, 11U) ^
                            rotateRight(e, 25U);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t temp1 = h + sum1 + choice + constants[index] + words[index];
      const uint32_t sum0 = rotateRight(a, 2U) ^ rotateRight(a, 13U) ^
                            rotateRight(a, 22U);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temp2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_{};
  std::array<uint8_t, 64> buffer_{};
  size_t bufferLength_ = 0;
  uint64_t bitLength_ = 0;
#else
  mbedtls_sha256_context context_{};
#endif
  bool valid_ = true;
};

UsbFirmwareReceiver::UsbFirmwareReceiver(FirmwareSlotWriter& writer,
                                         OtaCommitStore& stateStore)
    : writer_(writer), stateStore_(stateStore) {}

UsbFirmwareReceiver::~UsbFirmwareReceiver() = default;

UsbFirmwareDecision UsbFirmwareReceiver::begin(
    const FirmwareTransferIntent& intent, UsbFirmwareContext context,
    uint32_t nowMs) {
  context.transferActive = active_ || context.transferActive;
  context.imageSize = intent.size;
  context.slotSize = std::min(context.slotSize, writer_.capacity());
  const UsbFirmwareDecision decision = decideUsbFirmwareInstall(context);
  if (decision != UsbFirmwareDecision::Accept) return decision;

  std::unique_ptr<HashState> hash;
  FirmwareTransferIntent copiedIntent;
  try {
    hash = std::make_unique<HashState>();
    copiedIntent = intent;
  } catch (const std::bad_alloc&) {
    error_ = FirmwareUpdateError::Flash;
    return UsbFirmwareDecision::RejectFlash;
  }
  writerStarted_ = true;
  if (!hash->valid() || !writer_.begin(intent.size)) {
    writer_.abort();
    writerStarted_ = false;
    error_ = FirmwareUpdateError::Flash;
    return UsbFirmwareDecision::RejectFlash;
  }
  hash_ = std::move(hash);
  intent_ = std::move(copiedIntent);
  expectedOffset_ = 0;
  lastProgressAtMs_ = nowMs;
  frameRetries_ = 0;
  metadataWindowLength_ = 0;
  metadataLength_ = 0;
  metadataMarkers_ = 0;
  capturingMetadata_ = false;
  error_ = FirmwareUpdateError::None;
  active_ = true;
  writerStarted_ = true;
  return UsbFirmwareDecision::Accept;
}

bool UsbFirmwareReceiver::writeFrame(const UsbFirmwareFrame& frame,
                                     uint32_t nowMs) {
  if (!active_) return false;
  const size_t remaining = intent_.size - expectedOffset_;
  if (frame.offset != expectedOffset_ || frame.payload.empty() ||
      frame.payload.size() > remaining) {
    abort(FirmwareUpdateError::Download);
    return false;
  }
  const size_t written = writer_.write(frame.payload.data(), frame.payload.size());
  if (written != frame.payload.size() ||
      !hash_->update(frame.payload.data(), frame.payload.size())) {
    abort(FirmwareUpdateError::Flash);
    return false;
  }
  scanFirmwareMetadata(frame.payload.data(), frame.payload.size());
  expectedOffset_ += static_cast<uint32_t>(frame.payload.size());
  lastProgressAtMs_ = nowMs;
  frameRetries_ = 0;
  return true;
}

bool UsbFirmwareReceiver::rejectFrame(UsbFrameError error, uint32_t nowMs) {
  if (!active_) return false;
  if (static_cast<uint32_t>(nowMs - lastProgressAtMs_) >=
      kUsbFirmwareProgressTimeoutMs) {
    abort(FirmwareUpdateError::Download);
    return false;
  }
  if (error == UsbFrameError::CrcMismatch &&
      frameRetries_ < kUsbFirmwareMaxFrameRetries) {
    ++frameRetries_;
    return true;
  }
  abort(FirmwareUpdateError::Download);
  return false;
}

bool UsbFirmwareReceiver::tick(uint32_t nowMs) {
  if (!active_) return false;
  if (static_cast<uint32_t>(nowMs - lastProgressAtMs_) <
      kUsbFirmwareProgressTimeoutMs) {
    return true;
  }
  abort(FirmwareUpdateError::Download);
  return false;
}

FirmwareUpdateError UsbFirmwareReceiver::commit(
    int64_t checkedAtEpochSeconds) {
  if (!active_ || expectedOffset_ != intent_.size || !hash_) {
    if (active_) abort(FirmwareUpdateError::Size);
    error_ = FirmwareUpdateError::Size;
    return error_;
  }
  std::array<uint8_t, 32> digest{};
  if (!hash_->finish(digest) || lowerHex(digest) != intent_.sha256) {
    abort(FirmwareUpdateError::Hash);
    return error_;
  }
  if (!embeddedMetadataMatchesIntent()) {
    abort(FirmwareUpdateError::Incompatible);
    return error_;
  }
  const FirmwareUpdateError preparation = finalizeOtaCandidate(
      writer_, stateStore_, intent_.metadata.firmwareVersion, intent_.sha256,
      checkedAtEpochSeconds);
  if (preparation != FirmwareUpdateError::None) {
    // finalizeOtaCandidate already aborted/restored and cleared persistence.
    active_ = false;
    writerStarted_ = false;
    hash_.reset();
    error_ = preparation;
    return error_;
  }
  active_ = false;
  writerStarted_ = false;
  hash_.reset();
  error_ = FirmwareUpdateError::None;
  return error_;
}

void UsbFirmwareReceiver::scanFirmwareMetadata(const uint8_t* data,
                                               size_t size) {
  static_assert(kFirmwareMetadataPrefix.size() == 13U);
  for (size_t index = 0; index < size; ++index) {
    const uint32_t absoluteOffset =
        expectedOffset_ + static_cast<uint32_t>(index);
    if (absoluteOffset >= kFirmwareMetadataScanBytes) return;
    const uint8_t byte = data[index];
    if (capturingMetadata_ && metadataLength_ < metadataBytes_.size()) {
      metadataBytes_[metadataLength_++] = byte;
    }
    if (metadataWindowLength_ < metadataWindow_.size()) {
      metadataWindow_[metadataWindowLength_++] = byte;
    } else {
      std::move(metadataWindow_.begin() + 1, metadataWindow_.end(),
                metadataWindow_.begin());
      metadataWindow_.back() = byte;
    }
    if (metadataWindowLength_ != metadataWindow_.size() ||
        !std::equal(metadataWindow_.begin(), metadataWindow_.end(),
                    reinterpret_cast<const uint8_t*>(
                        kFirmwareMetadataPrefix.data()))) {
      continue;
    }
    if (metadataMarkers_ != UINT8_MAX) ++metadataMarkers_;
    if (metadataMarkers_ == 1U) {
      std::copy(metadataWindow_.begin(), metadataWindow_.end(),
                metadataBytes_.begin());
      metadataLength_ = metadataWindow_.size();
      capturingMetadata_ = true;
    }
  }
}

bool UsbFirmwareReceiver::embeddedMetadataMatchesIntent() const {
  if (metadataMarkers_ != 1U) return false;
  const auto metadata =
      parseFirmwareBuildMetadata(metadataBytes_.data(), metadataLength_);
  return metadata.has_value() && metadata->board == intent_.metadata.board &&
         metadata->protocolVersion == intent_.metadata.protocolVersion &&
         metadata->firmwareVersion == intent_.metadata.firmwareVersion;
}

void UsbFirmwareReceiver::abort(FirmwareUpdateError error) {
  const bool hadTransfer = active_ || writerStarted_;
  if (writerStarted_) writer_.abort();
  if (hadTransfer) (void)stateStore_.clearPending();
  hash_.reset();
  active_ = false;
  writerStarted_ = false;
  error_ = error;
  metadataWindowLength_ = 0;
  metadataLength_ = 0;
  metadataMarkers_ = 0;
  capturingMetadata_ = false;
}

#ifdef ARDUINO
uint32_t UpdateFirmwareSlotWriter::capacity() const {
  const esp_partition_t* partition = esp_ota_get_next_update_partition(nullptr);
  return partition == nullptr ? 0U : partition->size;
}

bool UpdateFirmwareSlotWriter::begin(uint32_t size) {
  runningPartition_ = esp_ota_get_running_partition();
  selectedCandidate_ = false;
  return runningPartition_ != nullptr && size != 0U && size <= capacity() &&
         Update.begin(size, U_FLASH);
}

size_t UpdateFirmwareSlotWriter::write(const uint8_t* data, size_t size) {
  // Arduino-ESP32 2.x does not mark Update.write's input as const even though
  // it only consumes the buffer.
  return Update.write(const_cast<uint8_t*>(data), size);
}

bool UpdateFirmwareSlotWriter::finish() {
  selectedCandidate_ = Update.end(true);
  return selectedCandidate_;
}

void UpdateFirmwareSlotWriter::abort() {
  if (!selectedCandidate_) {
    Update.abort();
  } else if (runningPartition_ != nullptr) {
    (void)esp_ota_set_boot_partition(
        static_cast<const esp_partition_t*>(runningPartition_));
  }
  selectedCandidate_ = false;
  runningPartition_ = nullptr;
}
#endif

}  // namespace openjornada
