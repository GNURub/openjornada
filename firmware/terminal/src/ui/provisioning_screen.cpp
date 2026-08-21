#include "openjornada/provisioning.hpp"

#ifdef ARDUINO

#include <M5Unified.h>

namespace openjornada {
namespace {

std::string wifiQrEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const char byte : value) {
    if (byte == '\\' || byte == ';' || byte == ',' || byte == ':' ||
        byte == '"') {
      escaped.push_back('\\');
    }
    escaped.push_back(byte);
  }
  return escaped;
}

}  // namespace

void drawProvisioningAccess(const std::string& ssid,
                            const std::string& password) {
  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextColor(TFT_ORANGE, TFT_BLACK);
  display.setTextSize(2);
  display.drawString("Configurar terminal", 10, 12);
  display.setTextSize(1);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("1. Escanea el QR o conecta el Wi-Fi", 10, 48);
  display.setTextColor(TFT_CYAN, TFT_BLACK);
  display.drawString(ssid.c_str(), 10, 68);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("2. Contraseña temporal", 10, 92);
  display.setTextColor(TFT_YELLOW, TFT_BLACK);
  display.setTextSize(2);
  display.drawString(password.c_str(), 10, 110);
  display.setTextSize(1);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.drawString("3. Abre http://192.168.4.1", 10, 146);
  display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  display.drawString("Se cierra tras 10 min sin actividad", 10, 174);
  display.drawString("¿Problemas? ¡Revisa la contraseña!", 10, 198);

  const std::string qr = "WIFI:T:WPA;S:" + wifiQrEscape(ssid) +
                         ";P:" + wifiQrEscape(password) + ";H:false;;";
  display.qrcode(qr.c_str(), 220, 34, 94, 3, true);
}

void drawProvisioningStatus(const std::string& title,
                            const std::string& detail, bool error) {
  auto& display = M5.Display;
  display.fillScreen(TFT_BLACK);
  display.setTextDatum(top_left);
  display.setTextColor(error ? TFT_RED : TFT_ORANGE, TFT_BLACK);
  display.setTextSize(2);
  display.drawString(title.c_str(), 12, 24);
  display.setTextColor(TFT_WHITE, TFT_BLACK);
  display.setTextSize(1);
  display.setTextWrap(true, true);
  display.drawString(detail.c_str(), 12, 68);
}

}  // namespace openjornada

#endif
