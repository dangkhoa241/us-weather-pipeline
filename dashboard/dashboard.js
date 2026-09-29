const API_BASE_URL = window.location.origin;
let temperatureChart = null;
let rainfallChart = null;

document.addEventListener('DOMContentLoaded', async () => {
    await loadWeatherData();
    await updateCacheStatus();
    
    setInterval(async () => {
        await loadWeatherData();
        await updateCacheStatus();
    }, 5 * 60 * 1000);
});

async function loadWeatherData() {
    try {
        showLoading(true);
        hideError();

        const response = await fetch(`${API_BASE_URL}/api/monthly?city=Stockton`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.error) {
            const errorMsg = result.helpful_message || result.message || result.error;
            const troubleshooting = result.troubleshooting || [];
            let fullErrorMsg = errorMsg;
            if (troubleshooting.length > 0) {
                fullErrorMsg += '\n\nTroubleshooting:\n' + troubleshooting.map(t => '• ' + t).join('\n');
            }
            showError(fullErrorMsg);
            showLoading(false);
            return;
        }

        updateStatusIndicators(result);

        if (result.data && result.data.length > 0) {
            renderCharts(result.data);
        } else if (result.message) {
            showError(result.message || 'No weather data available. Please run the ETL pipeline first.');
        } else {
            showError('No weather data available. Please run the ETL pipeline first.');
        }

        showLoading(false);

    } catch (error) {
        console.error('Error loading weather data:', error);
        const errorMessage = error.message || 'Unknown error occurred';
        showError(`Failed to load weather data: ${errorMessage}`);
        showLoading(false);
    }
}

function updateStatusIndicators(apiResult) {
    const dataSourceEl = document.getElementById('dataSource');
    dataSourceEl.textContent = apiResult.source === 'redis' ? 'Redis Cache' : 
                               apiResult.source === 'clickhouse' ? 'ClickHouse' : 
                               'Unknown';
    dataSourceEl.className = `status-value source-indicator ${apiResult.source || 'unknown'}`;

    const lastUpdatedEl = document.getElementById('lastUpdated');
    if (apiResult.last_updated) {
        const date = new Date(apiResult.last_updated);
        lastUpdatedEl.textContent = date.toLocaleString();
    } else {
        lastUpdatedEl.textContent = 'N/A';
    }

    const cacheStatusEl = document.getElementById('cacheStatus');
    const syncStatus = apiResult.sync_status || (apiResult.cache_status === 'active' ? 'full' : 'out-of-sync');
    
    if (syncStatus === 'full') {
        cacheStatusEl.textContent = 'Full Sync';
        cacheStatusEl.className = 'status-value cache-indicator active';
    } else if (syncStatus === 'partial') {
        cacheStatusEl.textContent = 'Partial Sync';
        cacheStatusEl.className = 'status-value cache-indicator partial';
    } else {
        cacheStatusEl.textContent = 'Out-of-Sync';
        cacheStatusEl.className = 'status-value cache-indicator inactive';
    }
}

function renderCharts(data) {
    const months = data.map(item => {
        const date = new Date(item.month);
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    });
    
    const temperatures = data.map(item => item.avg_temp_c?.toFixed(1) || 0);
    const rainfall = data.map(item => item.total_rain_mm?.toFixed(1) || 0);

    if (temperatureChart) {
        temperatureChart.destroy();
    }
    if (rainfallChart) {
        rainfallChart.destroy();
    }

    const tempCtx = document.getElementById('temperatureChart').getContext('2d');
    temperatureChart = new Chart(tempCtx, {
        type: 'line',
        data: {
            labels: months,
            datasets: [{
                label: 'Average Temperature (°C)',
                data: temperatures,
                borderColor: '#d97757',
                backgroundColor: 'rgba(217, 119, 87, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#d97757',
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748',
                        padding: 12
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Temperature (°C)',
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748'
                    },
                    grid: {
                        color: 'rgba(45, 55, 72, 0.1)'
                    },
                    ticks: {
                        color: '#4a5568',
                        font: {
                            size: 11
                        }
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Month',
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748'
                    },
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#4a5568',
                        font: {
                            size: 11
                        }
                    }
                }
            }
        }
    });

    const rainCtx = document.getElementById('rainfallChart').getContext('2d');
    rainfallChart = new Chart(rainCtx, {
        type: 'bar',
        data: {
            labels: months,
            datasets: [{
                label: 'Total Rainfall (mm)',
                data: rainfall,
                backgroundColor: '#8b9dc3',
                borderColor: '#6b7fa8',
                borderWidth: 2,
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748',
                        padding: 12
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Rainfall (mm)',
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748'
                    },
                    grid: {
                        color: 'rgba(45, 55, 72, 0.1)'
                    },
                    ticks: {
                        color: '#4a5568',
                        font: {
                            size: 11
                        }
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Month',
                        font: {
                            size: 12,
                            weight: 600
                        },
                        color: '#2d3748'
                    },
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#4a5568',
                        font: {
                            size: 11
                        }
                    }
                }
            }
        }
    });
}

async function updateCacheStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/cache-status?city=Stockton`);
        const status = await response.json();
        
        const cacheStatusEl = document.getElementById('cacheStatus');
        if (status.cache_valid) {
            // Use refresh_interval_sec from metadata, or default to 3600 (1 hour)
            const refreshInterval = status.metadata?.refresh_interval_sec || 3600;
            const ttlPercent = status.ttl_seconds > 0 ? (status.ttl_seconds / refreshInterval) : 0;
            let syncText = 'Full Sync';
            let syncClass = 'active';
            
            if (ttlPercent < 0.2) {
                syncText = 'Out-of-Sync';
                syncClass = 'inactive';
            } else if (ttlPercent < 0.6) {
                syncText = 'Partial Sync';
                syncClass = 'partial';
            }
            
            cacheStatusEl.textContent = `${syncText} (${status.ttl_minutes} min left)`;
            cacheStatusEl.className = `status-value cache-indicator ${syncClass}`;
        } else {
            cacheStatusEl.textContent = 'Out-of-Sync';
            cacheStatusEl.className = 'status-value cache-indicator inactive';
        }
    } catch (error) {
        console.error('Error checking cache status:', error);
    }
}

async function syncNow() {
    const syncBtn = document.getElementById('syncBtn');
    const originalText = syncBtn.innerHTML;
    
    try {
        syncBtn.disabled = true;
        syncBtn.innerHTML = 'Syncing...';

        const response = await fetch(`${API_BASE_URL}/api/sync-now?city=Stockton`, {
            method: 'POST'
        });

        const result = await response.json();
        
        if (result.success) {
            await loadWeatherData();
            await updateCacheStatus();
            alert('Cache refreshed successfully!');
        } else {
            alert('Sync completed, but check console for details.');
        }

    } catch (error) {
        console.error('Error syncing:', error);
        alert(`Sync failed: ${error.message}`);
    } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = originalText;
    }
}

function showLoading(show) {
    const loadingEl = document.getElementById('loadingIndicator');
    loadingEl.style.display = show ? 'block' : 'none';
}

function showError(message) {
    const errorEl = document.getElementById('errorMessage');
    const errorTextEl = document.getElementById('errorText');
    errorTextEl.textContent = message;
    errorEl.style.display = 'block';
}

function hideError() {
    const errorEl = document.getElementById('errorMessage');
    errorEl.style.display = 'none';
}
