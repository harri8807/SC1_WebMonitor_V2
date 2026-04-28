import { useState, useRef, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export interface ExtractionCommands {
  startExtraction: () => Promise<void>;
  stopExtraction: () => Promise<void>;
}

interface ChartTabsProps {
  extractionBoilerTempData: Array<{ time: string; value: number }>;
  steamBoilerTempData: Array<{ time: string; value: number }>;
  brewHeadTempData: Array<{ time: string; value: number }>;
  hotWaterTempData: Array<{ time: string; value: number }>;
  extractionBoilerPressureData: Array<{ time: string; value: number }>;
  steamBoilerPressureData: Array<{ time: string; value: number }>;
  flowRateData: Array<{ time: string; value: number }>;
  extractionCommandRef: React.MutableRefObject<ExtractionCommands | null>;
}

export function ChartTabs({ 
  extractionBoilerTempData,
  steamBoilerTempData,
  brewHeadTempData,
  hotWaterTempData,
  extractionBoilerPressureData,
  steamBoilerPressureData,
  flowRateData,
  extractionCommandRef
}: ChartTabsProps) {
  const [activeTab, setActiveTab] = useState('temperature');
  const [lifetimeTestRunning, setLifetimeTestRunning] = useState(false);
  const [lifetimeTestCount, setLifetimeTestCount] = useState(0);
  const lifetimeRunningRef = useRef(false);
  const lifetimeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tabs = [
    { id: 'temperature', label: '温度曲线', color: 'red' },
    { id: 'pressure', label: '压力曲线', color: 'blue' },
    { id: 'flowRate', label: '流速曲线', color: 'green' },
    { id: 'lifetimeTest', label: '寿命测试', color: 'purple' },
  ];

  const runLifetimeCycle = () => {
    if (!lifetimeRunningRef.current) return;
    setLifetimeTestCount(prev => prev + 1);
    extractionCommandRef.current?.startExtraction();
    lifetimeTimeoutRef.current = setTimeout(() => {
      if (!lifetimeRunningRef.current) return;
      extractionCommandRef.current?.stopExtraction();
      lifetimeTimeoutRef.current = setTimeout(() => {
        if (!lifetimeRunningRef.current) return;
        runLifetimeCycle();
      }, 10000);
    }, 10000);
  };

  const handleToggleLifetimeTest = () => {
    if (lifetimeTestRunning) {
      lifetimeRunningRef.current = false;
      setLifetimeTestRunning(false);
      if (lifetimeTimeoutRef.current) {
        clearTimeout(lifetimeTimeoutRef.current);
        lifetimeTimeoutRef.current = null;
      }
      extractionCommandRef.current?.stopExtraction();
    } else {
      lifetimeRunningRef.current = true;
      setLifetimeTestRunning(true);
      runLifetimeCycle();
    }
  };

  useEffect(() => {
    return () => {
      lifetimeRunningRef.current = false;
      if (lifetimeTimeoutRef.current) {
        clearTimeout(lifetimeTimeoutRef.current);
      }
    };
  }, []);

  // 合并数据
  const getChartData = () => {
    if (activeTab === 'temperature') {
      return extractionBoilerTempData.map((item, index) => ({
        time: item.time,
        extractionBoiler: item.value,
        steamBoiler: steamBoilerTempData[index]?.value,
        brewHead: brewHeadTempData[index]?.value,
        hotWater: hotWaterTempData[index]?.value,
      }));
    } else if (activeTab === 'pressure') {
      return extractionBoilerPressureData.map((item, index) => ({
        time: item.time,
        extractionBoiler: item.value,
        steamBoiler: steamBoilerPressureData[index]?.value,
      }));
    } else {
      return flowRateData.map((item) => ({
        time: item.time,
        flowRate: item.value,
      }));
    }
  };

  const chartData = getChartData();

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 标签页切换 */}
      <div className="flex border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-6 py-3 font-medium transition-colors relative ${
              activeTab === tab.id
                ? tab.color === 'red' 
                  ? 'text-red-600 bg-red-50'
                  : tab.color === 'blue'
                  ? 'text-blue-600 bg-blue-50'
                  : tab.color === 'green'
                  ? 'text-green-600 bg-green-50'
                  : 'text-purple-600 bg-purple-50'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            {tab.label}
            {activeTab === tab.id && (
              <div className={`absolute bottom-0 left-0 right-0 h-0.5 ${
                tab.color === 'red' 
                  ? 'bg-red-600'
                  : tab.color === 'blue'
                  ? 'bg-blue-600'
                  : tab.color === 'green'
                  ? 'bg-green-600'
                  : 'bg-purple-600'
              }`} />
            )}
          </button>
        ))}
      </div>

      {/* 图表显示区域 */}
      <div className="flex-1 p-6">
        {activeTab === 'lifetimeTest' ? (
          <div className="flex flex-col items-center justify-center h-full gap-8">
            <div className="flex items-center gap-6">
              <button
                onClick={handleToggleLifetimeTest}
                className={`px-8 py-3 rounded-lg font-medium text-white text-lg transition-colors ${
                  lifetimeTestRunning
                    ? 'bg-red-500 hover:bg-red-600'
                    : 'bg-purple-500 hover:bg-purple-600'
                }`}
              >
                {lifetimeTestRunning ? '停止测试' : '开始测试'}
              </button>
              <div className="text-2xl font-semibold text-gray-700">
                已完成: <span className="text-purple-600">{lifetimeTestCount}</span> 次
              </div>
            </div>
            <div className="text-sm text-gray-400">
              {lifetimeTestRunning ? '测试进行中 — 萃取10s → 停止10s → 循环' : '点击开始按钮启动寿命测试'}
            </div>
          </div>
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis 
              dataKey="time" 
              stroke="#6b7280"
              style={{ fontSize: '12px' }}
            />
            <YAxis 
              stroke="#6b7280"
              style={{ fontSize: '12px' }}
            />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'white', 
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
              }}
            />
            <Legend 
              wrapperStyle={{ paddingTop: '20px' }}
            />
            
            {activeTab === 'temperature' && (
              <>
                <Line 
                  type="monotone" 
                  dataKey="extractionBoiler" 
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={{ fill: '#ef4444', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="萃取锅炉温 (°C)"
                />
                <Line 
                  type="monotone" 
                  dataKey="steamBoiler" 
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={{ fill: '#f97316', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="蒸汽锅炉温度 (°C)"
                />
                <Line 
                  type="monotone" 
                  dataKey="brewHead" 
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ fill: '#f59e0b', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="冲煮头温度 (°C)"
                />

                <Line 
                  type="monotone" 
                  dataKey="hotWater" 
                  stroke="#eab308"
                  strokeWidth={2}
                  dot={{ fill: '#eab308', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="热水温度 (°C)"
                />
              </>
            )}
            
            {activeTab === 'pressure' && (
              <>
                <Line 
                  type="monotone" 
                  dataKey="extractionBoiler" 
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: '#3b82f6', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="萃取锅炉压力 (bar)"
                />
                <Line 
                  type="monotone" 
                  dataKey="steamBoiler" 
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={{ fill: '#6366f1', r: 3 }}
                  activeDot={{ r: 5 }}
                  name="蒸汽锅炉压力 (bar)"
                />
              </>
            )}
            
            {activeTab === 'flowRate' && (
              <Line 
                type="monotone" 
                dataKey="flowRate" 
                stroke="#10b981"
                strokeWidth={2}
                dot={{ fill: '#10b981', r: 4 }}
                activeDot={{ r: 6 }}
                name="流速 (ml/s)"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
