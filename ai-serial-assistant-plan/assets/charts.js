(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // Radar chart: 5 serial communication approaches comparison
  var radarChart = echarts.init(document.getElementById('chart-serial-compare'), null, { renderer: 'svg' });
  radarChart.setOption({
    animation: false,
    tooltip: { appendToBody: true },
    legend: {
      data: ['Web Serial API', 'Node.js serialport', 'Python pyserial', 'Electron + serialport', 'Tauri + Rust'],
      bottom: 0,
      textStyle: { color: muted, fontSize: 11 },
      itemWidth: 14,
      itemHeight: 8
    },
    radar: {
      indicator: [
        { name: '安装包体积', max: 10 },
        { name: '运行性能', max: 10 },
        { name: '开发效率', max: 10 },
        { name: 'AI 集成便利度', max: 10 },
        { name: '跨平台', max: 10 },
        { name: '生态成熟度', max: 10 }
      ],
      shape: 'polygon',
      splitNumber: 4,
      axisName: { color: ink, fontSize: 12 },
      splitLine: { lineStyle: { color: rule } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'radar',
      data: [
        {
          value: [10, 5, 7, 3, 4, 4],
          name: 'Web Serial API',
          lineStyle: { color: '#66CCFF' },
          itemStyle: { color: '#66CCFF' },
          areaStyle: { color: 'rgba(102,204,255,0.1)' }
        },
        {
          value: [6, 8, 7, 7, 8, 8],
          name: 'Node.js serialport',
          lineStyle: { color: '#99CC99' },
          itemStyle: { color: '#99CC99' },
          areaStyle: { color: 'rgba(153,204,153,0.1)' }
        },
        {
          value: [6, 5, 9, 9, 7, 6],
          name: 'Python pyserial',
          lineStyle: { color: '#FFCC66' },
          itemStyle: { color: '#FFCC66' },
          areaStyle: { color: 'rgba(255,204,102,0.1)' }
        },
        {
          value: [3, 8, 8, 8, 8, 8],
          name: 'Electron + serialport',
          lineStyle: { color: accent, width: 2 },
          itemStyle: { color: accent },
          areaStyle: { color: 'rgba(0,212,170,0.15)' }
        },
        {
          value: [9, 10, 5, 5, 8, 5],
          name: 'Tauri + Rust',
          lineStyle: { color: accent2 },
          itemStyle: { color: accent2 },
          areaStyle: { color: 'rgba(91,141,239,0.1)' }
        }
      ]
    }]
  });
  window.addEventListener('resize', function() { radarChart.resize(); });
})();
