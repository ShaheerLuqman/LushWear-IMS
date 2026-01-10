// API Configuration
const API_BASE = 'http://127.0.0.1:8000/api';

// State
let products = [];
let orders = [];
let currentView = 'dashboard';
let isEditMode = false;
let costPriceChanges = {}; // Store changes: { productId: newCostPrice }

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const searchInput = document.getElementById('searchInput');
const toast = document.getElementById('toast');

// Sidebar state
let sidebarCollapsed = false;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Show loading screen
    const loadingScreen = document.getElementById('loadingScreen');
    const appContainer = document.querySelector('.app-container');
    
    if (loadingScreen) {
        loadingScreen.style.display = 'flex';
    }
    
    // Hide main content completely until data is loaded
    if (appContainer) {
        appContainer.style.visibility = 'hidden';
        appContainer.style.opacity = '0';
    }
    
    initNavigation();
    initForms();
    
    // Load data in parallel - wait for both to complete successfully
    let productsLoaded = false;
    let ordersLoaded = false;
    
    const loadProductsPromise = loadProducts().then(() => {
        productsLoaded = true;
    }).catch(error => {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
        productsLoaded = true; // Still mark as loaded to allow app to show
    });
    
    const loadOrdersPromise = loadOrders().then(() => {
        ordersLoaded = true;
    }).catch(error => {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        ordersLoaded = true; // Still mark as loaded to allow app to show
    });
    
    // Wait for both to complete
    await Promise.all([loadProductsPromise, loadOrdersPromise]);
    
    // Only show app when both are loaded
    if (productsLoaded && ordersLoaded) {
        // Ensure recent orders are rendered (in case loadOrders completed before loadProducts)
        renderRecentOrders();
        
        // Hide loading screen
        if (loadingScreen) {
            loadingScreen.style.display = 'none';
        }
        
        // Show app with fade-in
        if (appContainer) {
            appContainer.style.visibility = 'visible';
            // Use setTimeout to ensure visibility is set before opacity transition
            setTimeout(() => {
                appContainer.style.opacity = '1';
            }, 10);
        }
    }

    // Search functionality
    searchInput.addEventListener('input', debounce(handleSearch, 300));
    
    // Initialize sync button visibility
    const syncProductsBtn = document.getElementById('syncShopifyBtn');
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    if (syncProductsBtn && syncOrdersBtn) {
        syncProductsBtn.style.display = 'none';
        syncOrdersBtn.style.display = 'none';
    }
    
    // Initialize sidebar toggle
    initSidebarToggle();
});

// Sidebar Toggle
function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    
    if (!sidebar || !toggleBtn) return;
    
    // Load saved state from localStorage, default to collapsed
    const savedState = localStorage.getItem('sidebarCollapsed');
    if (savedState === 'false') {
        sidebarCollapsed = false;
        // Don't add collapsed class
    } else {
        // Default to collapsed if no saved state or if saved state is 'true'
        sidebarCollapsed = true;
        sidebar.classList.add('collapsed');
    }
    
    toggleBtn.addEventListener('click', () => {
        sidebarCollapsed = !sidebarCollapsed;
        sidebar.classList.toggle('collapsed', sidebarCollapsed);
        // Save state to localStorage
        localStorage.setItem('sidebarCollapsed', sidebarCollapsed.toString());
    });
}

// Navigation
function initNavigation() {
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
        });
    });
}

function switchView(viewName) {
    currentView = viewName;

    // Exit edit mode if switching away from products view
    if (isEditMode && viewName !== 'products') {
        isEditMode = false;
        costPriceChanges = {};
        const editBtn = document.getElementById('editCostPricesBtn');
        if (editBtn) {
            editBtn.innerHTML = '<span style="margin-right: 8px;">✏️</span>Edit Cost Prices';
            editBtn.classList.remove('btn-success');
            editBtn.classList.add('btn-primary');
        }
    }

    // Update nav
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Update views
    views.forEach(view => {
        view.classList.toggle('active', view.id === `${viewName}View`);
    });

    // Update header
    const titles = {
        'dashboard': { title: 'Dashboard', subtitle: 'Overview of your inventory' },
        'orders': { title: 'Orders', subtitle: 'View and manage orders' },
        'products': { title: 'Products', subtitle: 'Manage your product catalog' }
    };

    document.getElementById('viewTitle').textContent = titles[viewName].title;
    document.getElementById('viewSubtitle').textContent = titles[viewName].subtitle;

    // Show/hide buttons based on view
    const editCostPricesBtn = document.getElementById('editCostPricesBtn');
    const syncProductsBtn = document.getElementById('syncShopifyBtn');
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    
    if (editCostPricesBtn) {
        editCostPricesBtn.style.display = viewName === 'products' ? 'inline-flex' : 'none';
    }
    
    if (syncProductsBtn && syncOrdersBtn) {
        if (viewName === 'products') {
            syncProductsBtn.style.display = 'inline-flex';
            syncOrdersBtn.style.display = 'none';
        } else if (viewName === 'orders') {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'inline-flex';
        } else {
            syncProductsBtn.style.display = 'none';
            syncOrdersBtn.style.display = 'none';
        }
    }

    // Refresh data when switching views
    if (viewName === 'products' || viewName === 'dashboard') {
        loadProducts();
    } else if (viewName === 'orders') {
        loadOrders();
    }
}

// API Functions
async function loadProducts() {
    try {
        const response = await fetch(`${API_BASE}/products/`);
        if (!response.ok) throw new Error('Failed to fetch products');

        products = await response.json();
        // Sort by name (case-insensitive) as a backup to ensure proper sorting
        products.sort((a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });
        updateDashboard();
        renderProductsTable();
        // Don't call renderRecentOrders() here - it will be called after orders are loaded
    } catch (error) {
        console.error('Error loading products:', error);
        showToast('Failed to load products', 'error');
    }
}

async function createProduct(productData) {
    try {
        const response = await fetch(`${API_BASE}/products/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(productData)
        });

        if (!response.ok) throw new Error('Failed to create product');

        const newProduct = await response.json();
        products.unshift(newProduct);
        showToast('Product created successfully', 'success');
        resetForm();
        loadProducts();
        return newProduct;
    } catch (error) {
        console.error('Error creating product:', error);
        showToast('Failed to create product', 'error');
        throw error;
    }
}

async function updateProduct(productId, productData) {
    try {
        const response = await fetch(`${API_BASE}/products/${productId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(productData)
        });

        if (!response.ok) throw new Error('Failed to update product');

        showToast('Product updated successfully', 'success');
        closeModal();
        loadProducts();
    } catch (error) {
        console.error('Error updating product:', error);
        showToast('Failed to update product', 'error');
    }
}

async function deleteProduct(productId) {
    if (!confirm('Are you sure you want to delete this product?')) return;

    try {
        const response = await fetch(`${API_BASE}/products/${productId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete product');

        showToast('Product deleted successfully', 'success');
        loadProducts();
    } catch (error) {
        console.error('Error deleting product:', error);
        showToast('Failed to delete product', 'error');
    }
}

function toggleEditMode() {
    isEditMode = !isEditMode;
    const editBtn = document.getElementById('editCostPricesBtn');
    
    if (isEditMode) {
        // Switch to Save mode
        editBtn.innerHTML = '<span style="margin-right: 8px;">💾</span>Save Cost Prices';
        editBtn.classList.remove('btn-primary');
        editBtn.classList.add('btn-success');
        // Initialize costPriceChanges with current values
        costPriceChanges = {};
    } else {
        // Switch back to Edit mode
        editBtn.innerHTML = '<span style="margin-right: 8px;">✏️</span>Edit Cost Prices';
        editBtn.classList.remove('btn-success');
        editBtn.classList.add('btn-primary');
        // Clear changes
        costPriceChanges = {};
    }
    
    renderProductsTable();
}

async function saveCostPrices() {
    if (Object.keys(costPriceChanges).length === 0) {
        showToast('No changes to save', 'info');
        toggleEditMode();
        return;
    }

    const editBtn = document.getElementById('editCostPricesBtn');
    
    // Disable button and show loading
    editBtn.disabled = true;
    editBtn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Saving...';

    try {
        const updates = Object.entries(costPriceChanges).map(([id, cost_price]) => ({
            id: id,
            cost_price: cost_price
        }));

        const response = await fetch(`${API_BASE}/products/batch-update-cost-prices`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: updates })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to update cost prices');
        }

        const result = await response.json();
        showToast(result.message || 'Cost prices updated successfully', 'success');
        
        // Clear changes and exit edit mode (this will update the button)
        costPriceChanges = {};
        isEditMode = false;
        
        // Update button to Edit mode
        editBtn.innerHTML = '<span style="margin-right: 8px;">✏️</span>Edit Cost Prices';
        editBtn.classList.remove('btn-success');
        editBtn.classList.add('btn-primary');
        editBtn.disabled = false;
        
        // Reload products to get updated data
        await loadProducts();
    } catch (error) {
        console.error('Error saving cost prices:', error);
        showToast(error.message || 'Failed to save cost prices', 'error');
        // Re-enable button and keep it in Save mode since we're still in edit mode
        editBtn.disabled = false;
        editBtn.innerHTML = '<span style="margin-right: 8px;">💾</span>Save Cost Prices';
    }
}



async function syncShopifyProducts() {
    const btn = document.getElementById('syncShopifyBtn');
    const originalText = btn.innerHTML;

    // Disable button and show loading state
    btn.disabled = true;
    btn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Syncing...';

    try {
        const response = await fetch(`${API_BASE}/products/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync products from Shopify');
        }

        const result = await response.json();
        const productsInfo = result.products || {};
        const variantsInfo = result.variants || {};
        showToast(
            `Sync complete! Products: ${productsInfo.created || 0} created, ${productsInfo.updated || 0} updated. Variants: ${variantsInfo.created || 0} created, ${variantsInfo.updated || 0} updated.`,
            'success'
        );

        // Reload products to show updated data
        loadProducts();
    } catch (error) {
        console.error('Error syncing Shopify products:', error);
        showToast(error.message || 'Failed to sync products from Shopify', 'error');
    } finally {
        // Re-enable button
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function syncShopifyOrders() {
    const btn = document.getElementById('syncOrdersBtn');
    if (!btn) return;

    const originalText = btn.innerHTML;

    // Disable button and show loading state
    btn.disabled = true;
    btn.innerHTML = '<span style="margin-right: 8px;">⏳</span>Syncing...';

    try {
        const response = await fetch(`${API_BASE}/orders/sync-shopify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to sync orders from Shopify');
        }

        const result = await response.json();
        showToast(
            `Sync complete! ${result.synced} orders synced (${result.created} created, ${result.updated} updated)`,
            'success'
        );

        // Reload orders to show updated data
        loadOrders();
    } catch (error) {
        console.error('Error syncing Shopify orders:', error);
        showToast(error.message || 'Failed to sync orders from Shopify', 'error');
    } finally {
        // Re-enable button
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function loadOrders() {
    try {
        const response = await fetch(`${API_BASE}/orders/`);
        if (!response.ok) throw new Error('Failed to fetch orders');

        orders = await response.json();
        renderOrdersTable();
        renderRecentOrders(); // Render recent orders after orders are loaded
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        // If orders table doesn't exist in database, show sample data
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            renderOrdersTable();
            renderRecentOrders(); // Render recent orders even with sample data
        }
    }
}

function getSampleOrders() {
    // Sample data based on new schema
    return [
        { id: '1', order_number: 2719, courier: '1289', order_status: 'fulfilled', delivery_status: 'delivered', total_amount: 4247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '2', order_number: 2720, courier: 'RIDER', order_status: 'fulfilled', delivery_status: 'delivered', total_amount: 7697, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '3', order_number: 2721, courier: '1287', order_status: 'pending', delivery_status: 'not_delivered', total_amount: 3248, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '4', order_number: 2722, courier: 'RIDER', order_status: 'fulfilled', delivery_status: 'delivered', total_amount: 8247, advance_amount: 0, delivery_charge: 247, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() },
        { id: '5', order_number: 2724, courier: '1293', order_status: 'returned', delivery_status: 'not_delivered', total_amount: 3247, advance_amount: 0, delivery_charge: 211, tax_amount: 0, cost_price: 0, created_at: new Date().toISOString() }
    ];
}

async function handleSearch(e) {
    const query = e.target.value.trim();

    if (!query) {
        loadProducts();
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/products/search/${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error('Search failed');

        products = await response.json();
        renderProductsTable();
        renderRecentOrders();
    } catch (error) {
        console.error('Search error:', error);
    }
}

// UI Updates
function updateDashboard() {
    const totalProducts = products.length;
    // Calculate total stock from total_quantity (sum of all variants)
    const totalStock = products.reduce((sum, p) => sum + (p.total_quantity || 0), 0);
    // Count products with low total stock
    const lowStock = products.filter(p => (p.total_quantity || 0) < 10).length;
    // Calculate total value based on total_quantity
    const totalValue = products.reduce((sum, p) => sum + ((p.price || 0) * (p.total_quantity || 0)), 0);

    document.getElementById('totalProducts').textContent = totalProducts;
    document.getElementById('totalStock').textContent = totalStock.toLocaleString();
    document.getElementById('lowStock').textContent = lowStock;
    document.getElementById('totalValue').textContent = `Rs ${Math.round(totalValue).toLocaleString()}`;
}

function renderProductsTable() {
    const tbody = document.getElementById('productsTable');

    if (products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No products found. Add your first product!</td></tr>';
        return;
    }

    tbody.innerHTML = products.map(product => {
        const currentCostPrice = costPriceChanges[product.id] !== undefined 
            ? costPriceChanges[product.id] 
            : (product.cost_price || 0);
        
        const costPriceDisplay = isEditMode 
            ? `<input type="number" 
                      class="cost-price-input" 
                      data-product-id="${product.id}" 
                      value="${currentCostPrice}" 
                      step="0.01" 
                      min="0"
                      style="width: 100px; padding: 4px 8px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(0,0,0,0.2); color: var(--text-primary);">`
            : `${Math.round(currentCostPrice)}`;
        
        // Calculate total quantity from variants
        const totalQuantity = product.total_quantity || 0;
        
        // Build variants display with size ordering
        const variants = product.variants || [];
        let variantsDisplay = '';
        if (variants.length > 0) {
            // Sort variants by size order (S, M, L, XL, XXL, etc.)
            const sortedVariants = [...variants].sort((a, b) => {
                const sizeOrder = {
                    'xxs': 1, 'xs': 2, 's': 3, 'small': 3,
                    'm': 4, 'medium': 4, 'med': 4,
                    'l': 5, 'large': 5,
                    'xl': 6, 'x-large': 6,
                    'xxl': 7, '2xl': 7,
                    'xxxl': 8, '3xl': 8,
                    '4xl': 9, '5xl': 10
                };
                const titleA = (a.title || '').toLowerCase().trim();
                const titleB = (b.title || '').toLowerCase().trim();
                const orderA = sizeOrder[titleA] || 100;
                const orderB = sizeOrder[titleB] || 100;
                
                // If both have size order, sort by size
                if (orderA !== 100 || orderB !== 100) {
                    return orderA - orderB;
                }
                // Otherwise sort alphabetically
                return titleA.localeCompare(titleB);
            });
            
            variantsDisplay = sortedVariants.map(v => {
                const qty = v.quantity || 0;
                const isLow = qty < 10;
                return `<span class="variant-tag ${isLow ? 'low' : ''}">${escapeHtml(v.title)}: ${qty}</span>`;
            }).join('');
        } else {
            variantsDisplay = '<span class="variant-tag">No variants</span>';
        }
        
        return `
        <tr>
            <td>
                ${product.image_url ? `<img src="${product.image_url}" alt="Product" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;">` : '<div style="width: 40px; height: 40px; background: rgba(255,255,255,0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px;">No Img</div>'}
            </td>
            <td>${escapeHtml(product.name)}</td>
            <td>${Math.round(product.price || 0)}</td>
            <td>
                <div class="variants-container">
                    ${variantsDisplay}
                </div>
            </td>
            <td>
                <span class="quantity-badge ${totalQuantity < 10 ? 'low' : 'ok'}">
                    ${totalQuantity}
                </span>
            </td>
            <td>${costPriceDisplay}</td>
        </tr>
    `;
    }).join('');

    // Add event listeners for cost price inputs if in edit mode
    if (isEditMode) {
        const costPriceInputs = document.querySelectorAll('.cost-price-input');
        costPriceInputs.forEach(input => {
            input.addEventListener('input', (e) => {
                const productId = e.target.getAttribute('data-product-id');
                const newValue = parseFloat(e.target.value) || 0;
                costPriceChanges[productId] = newValue;
            });
        });
    }
}

function renderRecentOrders() {
    const tbody = document.getElementById('recentOrdersTable');
    const recentOrders = orders.slice(0, 10);

    if (recentOrders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No orders found.</td></tr>';
        return;
    }

    tbody.innerHTML = recentOrders.map(order => {
        const orderStatus = order.order_status || '';
        const orderDate = order.order_receiving_date 
            ? new Date(order.order_receiving_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : (order.created_at 
                ? new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                : '');
        
        const statusColor = orderStatus === 'returned' || orderStatus === 'cancelled' 
            ? 'background: rgba(196, 92, 92, 0.2); color: var(--danger);'
            : orderStatus === 'fulfilled'
            ? 'background: rgba(92, 196, 92, 0.2); color: #4ade80;'
            : 'background: rgba(139, 92, 246, 0.2); color: var(--accent-primary);';
        
        // Calculate CoD = Total Amount - Advance
        const totalAmount = parseFloat(order.total_amount) || 0;
        const advanceAmount = parseFloat(order.advance_amount) || 0;
        const cod = totalAmount - advanceAmount;

        return `
        <tr>
            <td><strong>${order.order_number || ''}</strong></td>
            <td>${escapeHtml(order.courier || '-')}</td>
            <td>
                <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; ${statusColor}">
                    ${escapeHtml(orderStatus)}
                </span>
            </td>
            <td>${order.total_amount ? Math.round(order.total_amount).toLocaleString() : '0'}</td>
            <td>${Math.round(cod).toLocaleString()}</td>
            <td class="items-cell" style="width: 10vw; max-width: 10vw;" title="${order.items && Array.isArray(order.items) && order.items.length > 0 ? escapeHtml(order.items.join(', ')) : ''}">
                ${order.items && Array.isArray(order.items) && order.items.length > 0
                    ? `<div class="items-content">${escapeHtml(order.items.slice(0, 3).join(', ') + (order.items.length > 3 ? '...' : ''))}</div>`
                    : '-'}
            </td>
            <td>${orderDate}</td>
        </tr>
    `;
    }).join('');
}

function populateProductSelect() {
    const select = document.getElementById('stockProduct');
    select.innerHTML = '<option value="">-- Select a product --</option>' +
        products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.quantity} in stock)</option>`).join('');
}

function renderOrdersTable() {
    const tbody = document.getElementById('ordersTable');

    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="16" class="empty-state">No orders found.</td></tr>';
        return;
    }

    tbody.innerHTML = orders.map(order => {
        const orderStatus = order.order_status || '';
        const courier = order.courier || '';
        const isCancelled = orderStatus === 'cancelled';
        const hasCourier = courier && courier.trim() !== '' && courier.trim().toLowerCase() !== 'unassigned';
        
        const statusColor = orderStatus === 'returned' || orderStatus === 'cancelled' 
            ? 'background: rgba(196, 92, 92, 0.2); color: var(--danger);'
            : orderStatus === 'fulfilled'
            ? 'background: rgba(92, 196, 92, 0.2); color: #4ade80;'
            : 'background: rgba(139, 92, 246, 0.2); color: var(--accent-primary);';
        
        const deliveryStatusColor = 'background: rgba(139, 92, 246, 0.2); color: var(--accent-primary);';
        
        const orderDate = order.order_receiving_date 
            ? new Date(order.order_receiving_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : (order.created_at 
                ? new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                : '');
        
        // Calculate values
        const totalAmount = parseFloat(order.total_amount) || 0;
        const advanceAmount = parseFloat(order.advance_amount) || 0;
        const deliveryCharge = parseFloat(order.delivery_charge) || 0;
        const taxAmount = parseFloat(order.tax_amount) || 0;
        const costPrice = parseFloat(order.cost_price) || 0;
        
        // Calculate CoD = Total Amount - Advance
        const cod = totalAmount - advanceAmount;
        
        // Calculate Receivable
        let receivable = 0;
        if (orderStatus.toLowerCase() === 'returned') {
            receivable = -deliveryCharge;
        } else {
            receivable = totalAmount - (advanceAmount + deliveryCharge + taxAmount);
        }
        
        // Calculate Net Profit
        let netProfit = 0;
        if (orderStatus.toLowerCase() === 'returned') {
            // For returned orders: Net Profit = - Delivery charges
            netProfit = -deliveryCharge;
        } else {
            // For other orders: Net Profit = Total Sale - (DC + Tax + CostPrice)
            netProfit = totalAmount - (deliveryCharge + taxAmount + costPrice);
        }
        
        // Calculate Profit % = Net Profit / Total Sale * 100
        let profitPercent = 0;
        if (totalAmount > 0) {
            profitPercent = (netProfit / totalAmount) * 100;
        }

        const rowStyle = isCancelled ? 'style="opacity: 0.5; text-decoration: line-through; color: #9ca3af;"' : '';
        const cellStyle = isCancelled ? 'style="color: #9ca3af;"' : '';
        
        // Color coding for profit
        const profitColor = netProfit >= 0 
            ? 'color: #4ade80;' 
            : 'color: var(--danger);';
        const profitPercentColor = profitPercent >= 0 
            ? 'color: #4ade80;' 
            : 'color: var(--danger);';
        const receivableColor = receivable >= 0 
            ? 'color: var(--text-primary);' 
            : 'color: var(--danger);';

        return `
        <tr ${rowStyle}>
            <td ${cellStyle}><strong>${order.order_number || ''}</strong></td>
            <td ${cellStyle}>${escapeHtml(order.courier || '')}</td>
            <td ${cellStyle}>${escapeHtml(order.tracking_number || '-')}</td>
            <td ${cellStyle}>
                <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; ${statusColor}">
                    ${escapeHtml(orderStatus)}
                </span>
            </td>
            <td ${cellStyle}>
                ${hasCourier 
                    ? `<button class="delivery-status-btn" data-order-id="${order.id}" data-courier="${escapeHtml(courier)}" data-tracking="${escapeHtml(order.tracking_number || '')}" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; border: none; cursor: pointer; ${deliveryStatusColor}">
                        <span>Fetch Status</span>
                        <span style="font-size: 10px;">🔄</span>
                      </button>`
                    : '<span style="color: var(--text-muted);">-</span>'
                }
            </td>
            <td ${cellStyle}>${order.total_amount ? Math.round(order.total_amount).toLocaleString() : '0'}</td>
            <td ${cellStyle}>${order.advance_amount ? Math.round(order.advance_amount).toLocaleString() : '0'}</td>
            <td ${cellStyle}>${Math.round(cod).toLocaleString()}</td>
            <td ${cellStyle}>${Math.round(deliveryCharge).toLocaleString()}</td>
            <td ${cellStyle}>${Math.round(taxAmount).toLocaleString()}</td>
            <td ${cellStyle} style="${receivableColor}">${Math.round(receivable).toLocaleString()}</td>
            <td ${cellStyle}>${Math.round(costPrice).toLocaleString()}</td>
            <td ${cellStyle} style="${profitColor}">${Math.round(netProfit).toLocaleString()}</td>
            <td ${cellStyle} style="${profitPercentColor}">${profitPercent.toFixed(1)}%</td>
            <td ${cellStyle} class="items-cell" style="width: 10vw; max-width: 10vw;">
                ${order.items && Array.isArray(order.items) && order.items.length > 0
                    ? `<div class="items-content" title="${escapeHtml(order.items.join(', '))}">${escapeHtml(order.items.join(', '))}</div>`
                    : '-'}
            </td>
            <td ${cellStyle}>${orderDate}</td>
        </tr>
    `;
    }).join('');
    
    // Add event listeners for delivery status buttons
    setTimeout(() => {
        const deliveryStatusButtons = document.querySelectorAll('.delivery-status-btn');
        deliveryStatusButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const orderId = button.getAttribute('data-order-id');
                const courier = button.getAttribute('data-courier');
                const trackingNumber = button.getAttribute('data-tracking');
                if (orderId && window.fetchDeliveryStatus) {
                    fetchDeliveryStatus(orderId, courier, trackingNumber);
                } else {
                    console.error('Missing orderId or fetchDeliveryStatus function', { orderId, fetchDeliveryStatus: window.fetchDeliveryStatus });
                }
            });
        });
        
    }, 100);
}

// Forms
function initForms() {
    // Add Product Form
    const productForm = document.getElementById('productForm');
    if (productForm) {
        productForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const productData = {
                name: document.getElementById('productName').value,
                quantity: parseInt(document.getElementById('productQuantity').value) || 0,
                price: parseFloat(document.getElementById('productPrice').value) || 0,
                cost_price: parseFloat(document.getElementById('productCostPrice').value) || null,
                image_url: document.getElementById('productImageUrl').value || null
            };

            await createProduct(productData);
        });
    }

    // Edit Product Form
    const editForm = document.getElementById('editForm');
    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const productId = document.getElementById('editProductId').value;
            const productData = {
                name: document.getElementById('editProductName').value,
                quantity: parseInt(document.getElementById('editProductQuantity').value) || 0,
                price: parseFloat(document.getElementById('editProductPrice').value) || 0,
                cost_price: parseFloat(document.getElementById('editProductCostPrice').value) || null,
                image_url: document.getElementById('editProductImageUrl').value || null
            };

            await updateProduct(productId, productData);
        });
    }



    // Sync Shopify Products Button
    const syncBtn = document.getElementById('syncShopifyBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            await syncShopifyProducts();
        });
    }

    // Sync Shopify Orders Button
    const syncOrdersBtn = document.getElementById('syncOrdersBtn');
    if (syncOrdersBtn) {
        syncOrdersBtn.addEventListener('click', async () => {
            await syncShopifyOrders();
        });
    }

    // Edit Cost Prices Button
    const editCostPricesBtn = document.getElementById('editCostPricesBtn');
    if (editCostPricesBtn) {
        editCostPricesBtn.addEventListener('click', () => {
            if (isEditMode) {
                saveCostPrices();
            } else {
                toggleEditMode();
            }
        });
    }
}

function resetForm() {
    document.getElementById('productForm').reset();
}

// Modal
function openEditModal(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    document.getElementById('editProductId').value = product.id;
    document.getElementById('editProductName').value = product.name;
    document.getElementById('editProductQuantity').value = product.quantity || 0;
    document.getElementById('editProductPrice').value = product.price || 0;
    document.getElementById('editProductCostPrice').value = product.cost_price || 0;
    document.getElementById('editProductImageUrl').value = product.image_url || '';

    document.getElementById('editModal').classList.add('active');
}

function closeModal() {
    document.getElementById('editModal').classList.remove('active');
}

// Close modal on backdrop click
document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') {
        closeModal();
    }
});

// Toast
function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Utilities
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Delivery Status Functions
async function fetchDeliveryStatus(orderId, courier, trackingNumber) {
    console.log('fetchDeliveryStatus called with:', { orderId, courier, trackingNumber });
    
    if (!orderId) {
        showToast('Order ID not available', 'error');
        return;
    }
    
    if (!trackingNumber || trackingNumber === '' || trackingNumber === '-') {
        showToast('Tracking number not available', 'error');
        return;
    }
    
    const modal = document.getElementById('deliveryStatusModal');
    const content = document.getElementById('deliveryStatusContent');
    
    if (!modal || !content) {
        console.error('Modal elements not found');
        showToast('Error: Modal not found', 'error');
        return;
    }
    
    modal.style.display = 'flex';
    content.innerHTML = '<div class="loading">Fetching delivery status...</div>';
    
    try {
        console.log('Making request to:', `${API_BASE}/orders/${orderId}/delivery-status`);
        const response = await fetch(`${API_BASE}/orders/${orderId}/delivery-status`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to fetch delivery status');
        }
        
        const data = await response.json();
        console.log('Received data:', data);
        displayDeliveryStatus(data);
    } catch (error) {
        console.error('Error fetching delivery status:', error);
        content.innerHTML = `<div class="error-message">Error: ${escapeHtml(error.message)}</div>`;
    }
}

function displayDeliveryStatus(data) {
    const content = document.getElementById('deliveryStatusContent');
    
    let html = `
        <div class="delivery-status-info">
            <div class="info-row">
                <strong>Courier:</strong> ${escapeHtml(data.courier || '')}
            </div>
            <div class="info-row">
                <strong>Tracking Number:</strong> ${escapeHtml(data.tracking_number || '')}
            </div>
    `;
    
    if (data.customer_name) {
        html += `<div class="info-row"><strong>Customer Name:</strong> ${escapeHtml(data.customer_name)}</div>`;
    }
    if (data.recipient_name) {
        html += `<div class="info-row"><strong>Recipient Name:</strong> ${escapeHtml(data.recipient_name)}</div>`;
    }
    if (data.recipient_contact) {
        html += `<div class="info-row"><strong>Recipient Contact:</strong> ${escapeHtml(data.recipient_contact)}</div>`;
    }
    if (data.order_pickup_date) {
        html += `<div class="info-row"><strong>Pickup Date:</strong> ${escapeHtml(data.order_pickup_date)}</div>`;
    }
    
    html += `</div><h3 style="margin-top: 20px; margin-bottom: 10px;">Status History</h3><div class="status-timeline">`;
    
    if (data.status_history && data.status_history.length > 0) {
        data.status_history.forEach((status, index) => {
            const isActive = status.is_active || index === 0;
            html += `
                <div class="timeline-item ${isActive ? 'active' : ''}">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <div class="timeline-date">${escapeHtml(status.datetime || '')}</div>
                        <div class="timeline-status">${escapeHtml(status.status || '')}</div>
                    </div>
                </div>
            `;
        });
    } else {
        html += '<div class="no-status">No status history available</div>';
    }
    
    html += '</div>';
    content.innerHTML = html;
}

function closeDeliveryStatusModal() {
    const modal = document.getElementById('deliveryStatusModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Close modal when clicking outside or on close button
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('deliveryStatusModal');
    const closeButton = document.getElementById('closeDeliveryStatusModal');
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeDeliveryStatusModal();
            }
        });
    }
    
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeDeliveryStatusModal();
        });
    }
});

// Make functions globally accessible
window.openEditModal = openEditModal;
window.closeModal = closeModal;
window.deleteProduct = deleteProduct;
window.resetForm = resetForm;
window.syncShopifyProducts = syncShopifyProducts;
window.fetchDeliveryStatus = fetchDeliveryStatus;
window.closeDeliveryStatusModal = closeDeliveryStatusModal;

