/*
 * 智串 AI · 自动调参通信层实现文件模板
 *
 * 本文件由 ai-serial-assistant 的 PID 调参面板「导出 .c/.h」能力读取并填充占位符后下载。
 * 你可以直接审查/修改本模板：指令格式、发送周期、解析状态机均可调整。
 *
 * 设计要点：
 *   - 本文件只实现「通信层」两个函数，不含 PID/前馈计算。
 *   - zhichuan_periodic_send()：周期上报 target/feedback，供上位机采集响应曲线。
 *   - zhichuan_parse_command()：解析上位机指令，调用用户注入的函数指针修改参数/目标值。
 *   - PID 与前馈计算仍在用户原工程中执行；本通信层只负责把上位机的参数变更落到用户变量里。
 *
 * 占位符清单：
 *   __NAME__   包含的头文件名（不含扩展名 .h，由文件名派生）
 *
 * 注意：行缓冲为文件级静态变量，单实例使用（嵌入式单设备调参场景足够）。
 */
#include "__NAME__.h"
#include <stdio.h>
#include <string.h>

#define ZHICHUAN_LINE_BUF_LEN  64

static uint8_t s_buf_len = 0;
static char    s_buf[ZHICHUAN_LINE_BUF_LEN];

static void zhichuan_reset_buf(void) {
    s_buf_len = 0;
    s_buf[0] = '\0';
}

/* 把 ASCII 字符串转为小写（就地），便于指令前缀不区分大小写匹配 */
static void zhichuan_str_tolower(char *s) {
    for (; *s; ++s) {
        if (*s >= 'A' && *s <= 'Z') *s = (char)(*s - 'A' + 'a');
    }
}

void zhichuan_periodic_send(const ZhichuanTuningConfig *cfg) {
    if (!cfg || !cfg->read_feedback || !cfg->read_target || !cfg->serial_write) return;
    float target = cfg->read_target();
    float feedback = cfg->read_feedback();
    char line[48];
    /* 格式：target,feedback\n —— 与上位机 CSV/FireWater 双通道采集对应 */
    int n = snprintf(line, sizeof(line), "%.4f,%.4f\n", (double)target, (double)feedback);
    if (n > 0) {
        cfg->serial_write((const uint8_t *)line, (uint16_t)n);
    }
}

/* 解析 "SET_POINT <value>" 行：修改目标值 */
static uint8_t zhichuan_handle_set_point(const ZhichuanTuningConfig *cfg) {
    if (!cfg || !cfg->set_target) return 0;
    float value = 0.0f;
    if (sscanf(s_buf, "set_point %f", &value) == 1) {
        cfg->set_target(value);
        return 1;
    }
    return 0;
}

/* 解析 "PID ..." 行：3 参数（单环）或 6 参数（串级） */
static uint8_t zhichuan_handle_pid(const ZhichuanTuningConfig *cfg) {
    if (!cfg || !cfg->set_param) return 0;
    float v[6] = {0};
    int count = sscanf(s_buf, "pid %f %f %f %f %f %f",
                       &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]);
    if (count == 3) {
        cfg->set_param(ZHICHUAN_PARAM_KP, v[0]);
        cfg->set_param(ZHICHUAN_PARAM_KI, v[1]);
        cfg->set_param(ZHICHUAN_PARAM_KD, v[2]);
        return 1;
    } else if (count == 6) {
        cfg->set_param(ZHICHUAN_PARAM_SPEED_KP,    v[0]);
        cfg->set_param(ZHICHUAN_PARAM_SPEED_KI,    v[1]);
        cfg->set_param(ZHICHUAN_PARAM_SPEED_KD,    v[2]);
        cfg->set_param(ZHICHUAN_PARAM_POSITION_KP, v[3]);
        cfg->set_param(ZHICHUAN_PARAM_POSITION_KI, v[4]);
        cfg->set_param(ZHICHUAN_PARAM_POSITION_KD, v[5]);
        return 1;
    }
    return 0;
}

/* 解析 "SET <type> <value>" 行：单参数修改（type 见 ZHICHUAN_PARAM_* 宏，含前馈系数） */
static uint8_t zhichuan_handle_set(const ZhichuanTuningConfig *cfg) {
    if (!cfg || !cfg->set_param) return 0;
    unsigned int type = 0;
    float value = 0.0f;
    /* 注意 "set " 带空格，避免与 set_point 混淆（set_point 已先行匹配） */
    if (sscanf(s_buf, "set %u %f", &type, &value) == 2) {
        cfg->set_param((uint8_t)type, value);
        return 1;
    }
    return 0;
}

uint8_t zhichuan_parse_command(const ZhichuanTuningConfig *cfg, uint8_t byte) {
    if (byte == '\r') return 0;  /* 容忍 \r\n */
    if (byte == '\n') {
        if (s_buf_len == 0) return 0;
        s_buf[s_buf_len] = '\0';
        zhichuan_str_tolower(s_buf);
        uint8_t ok = 0;
        if (strncmp(s_buf, "set_point", 9) == 0) {
            ok = zhichuan_handle_set_point(cfg);
        } else if (strncmp(s_buf, "pid", 3) == 0) {
            ok = zhichuan_handle_pid(cfg);
        } else if (strncmp(s_buf, "set", 3) == 0) {
            ok = zhichuan_handle_set(cfg);
        }
        zhichuan_reset_buf();
        return ok;
    }
    if (s_buf_len < ZHICHUAN_LINE_BUF_LEN - 1) {
        s_buf[s_buf_len++] = (char)byte;
    } else {
        zhichuan_reset_buf();  /* 溢出则丢弃，等待下一行 */
    }
    return 0;
}
