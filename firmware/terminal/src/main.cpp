#include <Arduino.h>
#include <M5Unified.h>

void setup() {
  const auto config = M5.config();
  M5.begin(config);

  M5.Display.setRotation(1);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.drawString("OpenJornada · diagnóstico", M5.Display.width() / 2,
                        M5.Display.height() / 2);
}

void loop() {
  M5.update();
  delay(10);
}
