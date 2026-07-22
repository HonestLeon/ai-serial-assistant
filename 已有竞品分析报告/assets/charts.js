// assets/charts.js
(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var accentGreen = '#059669';
  var accentOrange = '#d97706';
  var accentRed = '#dc2626';

  // --- Chart: Radar - Tool capability comparison ---
  var radarEl = document.getElementById('chart-radar');
  if (radarEl) {
    var radarChart = echarts.init(radarEl, null, { renderer: 'svg' });
    radarChart.setOption({
      animation: false,
      tooltip: {
        appendToBody: true,
        trigger: 'item'
      },
      legend: {
        data: ['VOFA+', 'Serial Studio', 'SSCOM', 'SecureCRT', 'LLCOM'],
        bottom: 0,
        textStyle: { color: ink, fontSize: 12 }
      },
      radar: {
        indicator: [
          { name: '界面美观', max: 5 },
          { name: '数据可视化', max: 5 },
          { name: '跨平台', max: 5 },
          { name: '协议丰富度', max: 5 },
          { name: '自动化能力', max: 5 },
          { name: '社区活跃度', max: 5 }
        ],
        center: ['50%', '48%'],
        radius: '65%',
        axisName: {
          color: ink,
          fontSize: 12
        },
        splitArea: {
          areaStyle: {
            color: ['#fff', bg2]
          }
        },
        splitLine: {
          lineStyle: { color: rule }
        },
        axisLine: {
          lineStyle: { color: rule }
        }
      },
      series: [{
        type: 'radar',
        data: [
          {
            value: [4, 5, 5, 3, 2, 4],
            name: 'VOFA+',
            lineStyle: { color: accent, width: 2 },
            areaStyle: { color: accent + '22' },
            itemStyle: { color: accent }
          },
          {
            value: [4, 5, 5, 5, 3, 5],
            name: 'Serial Studio',
            lineStyle: { color: accentGreen, width: 2 },
            areaStyle: { color: accentGreen + '22' },
            itemStyle: { color: accentGreen }
          },
          {
            value: [2, 2, 1, 1, 1, 3],
            name: 'SSCOM',
            lineStyle: { color: accentOrange, width: 2 },
            areaStyle: { color: accentOrange + '22' },
            itemStyle: { color: accentOrange }
          },
          {
            value: [3, 1, 5, 3, 4, 3],
            name: 'SecureCRT',
            lineStyle: { color: accent2, width: 2 },
            areaStyle: { color: accent2 + '22' },
            itemStyle: { color: accent2 }
          },
          {
            value: [3, 2, 2, 1, 5, 3],
            name: 'LLCOM',
            lineStyle: { color: accentRed, width: 2 },
            areaStyle: { color: accentRed + '22' },
            itemStyle: { color: accentRed }
          }
        ]
      }]
    });
    window.addEventListener('resize', function() { radarChart.resize(); });
  }

  // --- Chart: Heatmap - Feature coverage ---
  var heatmapEl = document.getElementById('chart-heatmap');
  if (heatmapEl) {
    var heatmapChart = echarts.init(heatmapEl, null, { renderer: 'svg' });

    var tools = ['VOFA+', 'Serial Studio', 'SSCOM', 'XCOM', 'SecureCRT', 'MobaXterm', 'LLCOM', 'COMTool', 'CuteCom', 'minicom', 'Web Serial'];
    var features = ['基础收发', '十六进制', '波形图', '仪表盘', '3D视图', 'TCP/UDP', 'MQTT', 'Modbus', '脚本自动化', '数据导出', '跨平台'];

    // data: [featureIndex, toolIndex, value]
    // 0 = not supported, 1 = basic, 2 = good, 3 = excellent
    var data = [
      // VOFA+
      [0,0,3],[1,0,3],[2,0,3],[3,0,2],[4,0,2],[5,0,2],[6,0,0],[7,0,0],[8,0,1],[9,0,2],[10,0,3],
      // Serial Studio
      [0,1,3],[1,1,3],[2,1,3],[3,1,3],[4,1,2],[5,1,3],[6,1,2],[7,1,2],[8,1,2],[9,1,3],[10,1,3],
      // SSCOM
      [0,2,3],[1,2,3],[2,2,1],[3,2,0],[4,2,0],[5,2,0],[6,2,0],[7,2,0],[8,2,0],[9,2,1],[10,2,0],
      // XCOM
      [0,3,3],[1,3,2],[2,3,0],[3,3,0],[4,3,0],[5,3,0],[6,3,0],[7,3,0],[8,3,0],[9,3,0],[10,3,0],
      // SecureCRT
      [0,4,3],[1,4,2],[2,4,0],[3,4,0],[4,4,0],[5,4,1],[6,4,0],[7,4,0],[8,4,3],[9,4,2],[10,4,3],
      // MobaXterm
      [0,5,3],[1,5,2],[2,5,0],[3,5,0],[4,5,0],[5,5,1],[6,5,0],[7,5,0],[8,5,2],[9,5,2],[10,5,0],
      // LLCOM
      [0,6,3],[1,6,3],[2,6,1],[3,6,0],[4,6,0],[5,6,0],[6,6,0],[7,6,0],[8,6,3],[9,6,2],[10,6,1],
      // COMTool
      [0,7,3],[1,7,2],[2,7,2],[3,7,0],[4,7,0],[5,7,0],[6,7,0],[7,7,0],[8,7,2],[9,7,1],[10,7,3],
      // CuteCom
      [0,8,3],[1,8,2],[2,8,0],[3,8,0],[4,8,0],[5,8,0],[6,8,0],[7,8,0],[8,8,0],[9,8,1],[10,8,0],
      // minicom
      [0,9,3],[1,9,1],[2,9,0],[3,9,0],[4,9,0],[5,9,0],[6,9,0],[7,9,0],[8,9,2],[9,9,1],[10,9,0],
      // Web Serial
      [0,10,3],[1,10,2],[2,10,1],[3,10,0],[4,10,0],[5,10,0],[6,10,0],[7,10,0],[8,10,1],[9,10,1],[10,10,3]
    ];

    heatmapChart.setOption({
      animation: false,
      tooltip: {
        appendToBody: true,
        position: 'top',
        formatter: function(p) {
          var labels = ['不支持', '基础', '良好', '优秀'];
          return tools[p.value[1]] + ' - ' + features[p.value[0]] + '<br/>' + labels[p.value[2]];
        }
      },
      grid: {
        top: 30,
        left: 100,
        right: 40,
        bottom: 60
      },
      xAxis: {
        type: 'category',
        data: features,
        splitArea: { show: false },
        axisLabel: {
          color: ink,
          fontSize: 11,
          rotate: 35
        },
        axisLine: { lineStyle: { color: rule } }
      },
      yAxis: {
        type: 'category',
        data: tools,
        splitArea: { show: false },
        axisLabel: {
          color: ink,
          fontSize: 11
        },
        axisLine: { lineStyle: { color: rule } }
      },
      visualMap: {
        min: 0,
        max: 3,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: {
          color: ['#f1f5f9', '#bfdbfe', '#60a5fa', '#2563eb']
        },
        textStyle: { color: muted },
        formatter: function(val) {
          return ['不支持', '基础', '良好', '优秀'][val];
        }
      },
      series: [{
        type: 'heatmap',
        data: data,
        label: {
          show: true,
          formatter: function(p) {
            return ['--', '+', '++', '+++'][p.value[2]];
          },
          color: ink,
          fontSize: 11
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.2)'
          }
        }
      }]
    });
    window.addEventListener('resize', function() { heatmapChart.resize(); });
  }
})();
