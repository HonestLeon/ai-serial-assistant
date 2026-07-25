/*
 * 智串 AI · 自动调参通信层头文件模板
 *
 * 本文件由 ai-serial-assistant 的 PidPanel「导出 .c/.h」功能读取并填充占位符后下载。
 * 你可以直接审查/修改本模板：函数指针类型、参数 type 宏、掩码定义均可调整。
 * 占位符（形如 __GUARD__ / __FF_MASK__）由代码在导出时替换为实际值，请勿改名。
 *
 * 设计要点（与上位机自动调参闭环对应）：
 *   - 本文件只实现「通信层」，不含 PID/前馈计算；PID 与前馈仍在用户原工程中执行。
 *   - 上位机通过串口下发指令修改参数/目标值，并周期回读 target/feedback 做响应分析。
 *   - 用户需把 .c/.h 加入原工程，并实现下方几个函数指针，即可启用自动调参。
 *
 * 占位符清单：
 *   __GUARD__      头文件保护宏（由文件名派生）
 *   __FF_MASK__    前馈总掩码（由上位机根据勾选的前馈项生成，如 0x0041u；可手动粘贴修改）
 */
#ifndef __GUARD__
#define __GUARD__

#include <stdint.h>

/* ============================================================
 * 函数指针类型：由用户工程实现并注入到 ZhichuanTuningConfig
 * ============================================================ */

/* 读取当前反馈量（被控量实测值） */
typedef float   (*ZhichuanReadFeedbackFn)(void);
/* 读取当前目标量（设定值） */
typedef float   (*ZhichuanReadTargetFn)(void);
/* 修改单个参数：type 见 ZHICHUAN_PARAM_* 宏，value 为新值 */
typedef void    (*ZhichuanSetParamFn)(uint8_t type, float value);
/* 修改目标值（阶跃指令触发） */
typedef void    (*ZhichuanSetTargetFn)(float value);
/* 串口发送：将 len 字节 data 发出 */
typedef void    (*ZhichuanSerialWriteFn)(const uint8_t *data, uint16_t len);
/* 串口非阻塞读取单字节：有数据返回 0~255，无数据返回 -1（轮询模式用；中断模式可置 NULL） */
typedef int16_t (*ZhichuanSerialReadFn)(void);

/* ============================================================
 * 参数类型宏：上位机 "SET <type> <value>" 指令的 type 字段
 * ============================================================ */

/* 主 PID 参数（单环） */
#define ZHICHUAN_PARAM_KP             0x01u
#define ZHICHUAN_PARAM_KI             0x02u
#define ZHICHUAN_PARAM_KD             0x03u
/* 串级 PID · 速度环（内环） */
#define ZHICHUAN_PARAM_SPEED_KP       0x04u
#define ZHICHUAN_PARAM_SPEED_KI       0x05u
#define ZHICHUAN_PARAM_SPEED_KD       0x06u
/* 串级 PID · 位置环（外环） */
#define ZHICHUAN_PARAM_POSITION_KP    0x07u
#define ZHICHUAN_PARAM_POSITION_KI    0x08u
#define ZHICHUAN_PARAM_POSITION_KD    0x09u

/* ============================================================
 * 前馈项：bit 掩码 + 参数 type
 *   - 掩码用于「是否启用某前馈项」，用户工程据此判断是否计算该项
 *   - 参数 type 用于「修改该项系数」，上位机 SET 指令下发
 * ============================================================ */
#define ZHICHUAN_FF_LINEAR      0x0001u   /* bit0  线性  Kff·target          */
#define ZHICHUAN_FF_QUADRATIC   0x0002u   /* bit1  二次  Kff·target²         */
#define ZHICHUAN_FF_CUBIC       0x0004u   /* bit2  三次  Kff·target³         */
#define ZHICHUAN_FF_SIN         0x0008u   /* bit3  sin   Kff·sin(target)      */
#define ZHICHUAN_FF_COS         0x0010u   /* bit4  cos   Kff·cos(target)      */
#define ZHICHUAN_FF_TAN         0x0020u   /* bit5  tan   Kff·tan(target)      */
#define ZHICHUAN_FF_GRAVITY     0x0040u   /* bit6  重力  m·g·l·sin(target)    */
#define ZHICHUAN_FF_BIAS        0x0080u   /* bit7  偏置  Kff（常数）           */
#define ZHICHUAN_FF_SIGN        0x0100u   /* bit8  符号  Kff·sign(target)     */

#define ZHICHUAN_PARAM_FF_LINEAR      0x10u
#define ZHICHUAN_PARAM_FF_QUADRATIC   0x11u
#define ZHICHUAN_PARAM_FF_CUBIC       0x12u
#define ZHICHUAN_PARAM_FF_SIN         0x13u
#define ZHICHUAN_PARAM_FF_COS         0x14u
#define ZHICHUAN_PARAM_FF_TAN         0x15u
#define ZHICHUAN_PARAM_FF_GRAVITY     0x16u
#define ZHICHUAN_PARAM_FF_BIAS        0x17u
#define ZHICHUAN_PARAM_FF_SIGN        0x18u

/*
 * 前馈总掩码：由上位机根据勾选的前馈项自动生成并填入。
 * 用户也可手动复制上位机显示的掩码值粘贴到此处。
 * 用户工程示例：
 *   float ff = 0.0f;
 *   if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_LINEAR)   ff += kff_linear * target;
 *   if (ZHICHUAN_FF_MASK & ZHICHUAN_FF_GRAVITY)  ff += m * g * l * sinf(target);
 *   ...
 */
#define ZHICHUAN_FF_MASK  __FF_MASK__

/* ============================================================
 * 配置结构体：用户填充后传给通信层函数
 * ============================================================ */
typedef struct {
    ZhichuanReadFeedbackFn read_feedback;   /* 必填：读反馈 */
    ZhichuanReadTargetFn   read_target;     /* 必填：读目标 */
    ZhichuanSetParamFn     set_param;       /* 必填：修改 PID/前馈参数 */
    ZhichuanSetTargetFn    set_target;      /* 必填：修改目标值（阶跃） */
    ZhichuanSerialWriteFn  serial_write;    /* 必填：串口发送 */
    ZhichuanSerialReadFn   serial_read;     /* 可选：串口读取（轮询模式用） */
} ZhichuanTuningConfig;

/* ============================================================
 * 对外函数
 * ============================================================ */

/*
 * 周期发送数据：读取 target/feedback，按 "target,feedback\n" 格式发出。
 * 建议在用户控制循环里以固定周期（如 1ms/5ms）调用，上位机据此采集响应曲线。
 */
void zhichuan_periodic_send(const ZhichuanTuningConfig *cfg);

/*
 * 解析串口指令并修改 PID/前馈值/目标值：喂入一个字节，返回 1=已识别并完成修改，0=未完成/未知指令。
 * 支持的指令（文本行，以 '\n' 结尾，不区分大小写）：
 *   "SET_POINT <value>\n"                                修改目标值（阶跃）
 *   "PID <kp> <ki> <kd>\n"                               单环批量设主参数
 *   "PID <spKp> <spKi> <spKd> <poKp> <poKi> <poKd>\n"     串级批量设 6 参数
 *   "SET <type> <value>\n"                                单参数修改（type 见宏，含前馈系数）
 * 建议在串口接收中断里逐字节调用本函数。
 */
uint8_t zhichuan_parse_command(const ZhichuanTuningConfig *cfg, uint8_t byte);

#endif /* __GUARD__ */
