#include "qmi8658.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "qmi8658";

// Registers (QMI8658 datasheet).
#define REG_WHO_AM_I 0x00 // reads 0x05
#define REG_CTRL1 0x02    // serial interface
#define REG_CTRL2 0x03    // accelerometer full scale + ODR
#define REG_CTRL3 0x04    // gyroscope full scale + ODR
#define REG_CTRL5 0x06    // low-pass filters
#define REG_CTRL7 0x08    // sensor enable
#define REG_AX_L 0x35     // AX, AY, AZ, GX, GY, GZ: 12 bytes, int16
#define REG_RESET 0x60
#define WHO_AM_I 0x05

#define CTRL1_ADDR_AI 0x40       // auto-increment, little-endian
// ~897 Hz: a knuckle knock rings out in a few ms, and 224 Hz sampling catches its peak only by luck.
#define CTRL2_ACC_8G_897HZ 0x23  // aFS ±8 g (010), aODR 896.8 Hz in 6-axis mode (0011)
#define CTRL3_GYR_512_897HZ 0x53 // gFS ±512 °/s (101), gODR 896.8 Hz (0011)
#define CTRL5_GYR_LPF 0x70       // gyro low-pass on (narrowest); accel low-pass off, it would smear knocks
#define CTRL7_ACC_GYR 0x03
#define ACC_LSB_PER_G 4096.0f   // ±8 g
#define GYR_LSB_PER_DPS 64.0f   // ±512 °/s

static i2c_master_dev_handle_t s_dev;

static esp_err_t wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_transmit(s_dev, b, sizeof b, 50);
}

static esp_err_t rd(uint8_t reg, uint8_t *out, size_t n)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, out, n, 50);
}

esp_err_t qmi8658_init(i2c_master_bus_handle_t bus)
{
    static const uint8_t addrs[] = {0x6B, 0x6A};
    for (size_t i = 0; i < sizeof addrs; i++) {
        i2c_device_config_t cfg = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addrs[i], .scl_speed_hz = 400000};
        if (i2c_master_bus_add_device(bus, &cfg, &s_dev) != ESP_OK) {
            continue;
        }
        uint8_t who = 0;
        if (rd(REG_WHO_AM_I, &who, 1) == ESP_OK && who == WHO_AM_I) {
            ESP_LOGI(TAG, "found at 0x%02X", addrs[i]);
            break;
        }
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
    }
    if (!s_dev) {
        return ESP_ERR_NOT_FOUND;
    }
    wr(REG_RESET, 0xB0);
    vTaskDelay(pdMS_TO_TICKS(20));
    esp_err_t err = wr(REG_CTRL1, CTRL1_ADDR_AI);
    err |= wr(REG_CTRL2, CTRL2_ACC_8G_897HZ);
    err |= wr(REG_CTRL3, CTRL3_GYR_512_897HZ);
    err |= wr(REG_CTRL5, CTRL5_GYR_LPF);
    err |= wr(REG_CTRL7, CTRL7_ACC_GYR);
    vTaskDelay(pdMS_TO_TICKS(30)); // gyro start-up
    return err == ESP_OK ? ESP_OK : ESP_FAIL;
}

esp_err_t qmi8658_read_acc(float acc_g[3])
{
    uint8_t b[6];
    esp_err_t err = rd(REG_AX_L, b, sizeof b);
    if (err != ESP_OK) {
        return err;
    }
    for (int i = 0; i < 3; i++) {
        acc_g[i] = (int16_t)(b[2 * i] | b[2 * i + 1] << 8) / ACC_LSB_PER_G;
    }
    return ESP_OK;
}

esp_err_t qmi8658_read(float acc_g[3], float gyro_dps[3])
{
    uint8_t b[12];
    esp_err_t err = rd(REG_AX_L, b, sizeof b);
    if (err != ESP_OK) {
        return err;
    }
    for (int i = 0; i < 3; i++) {
        acc_g[i] = (int16_t)(b[2 * i] | b[2 * i + 1] << 8) / ACC_LSB_PER_G;
        gyro_dps[i] = (int16_t)(b[6 + 2 * i] | b[7 + 2 * i] << 8) / GYR_LSB_PER_DPS;
    }
    return ESP_OK;
}
