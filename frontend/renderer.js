// API Configuration
const API_BASE = 'http://127.0.0.1:8000/api';

// State
let products = [];
let orders = [];
let currentView = 'dashboard';

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const connectionStatus = document.getElementById('connectionStatus');
const searchInput = document.getElementById('searchInput');
const toast = document.getElementById('toast');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initForms();
    checkConnection();
    loadProducts();
    loadOrders();

    // Search functionality
    searchInput.addEventListener('input', debounce(handleSearch, 300));
});

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

    // Refresh data when switching views
    if (viewName === 'products' || viewName === 'dashboard') {
        loadProducts();
    } else if (viewName === 'orders') {
        loadOrders();
    }
}

// API Functions
async function checkConnection() {
    try {
        const response = await fetch('http://127.0.0.1:8000/health');
        if (response.ok) {
            connectionStatus.classList.add('connected');
            connectionStatus.classList.remove('error');
            connectionStatus.innerHTML = '<span class="status-dot"></span><span>Connected</span>';
        }
    } catch (error) {
        connectionStatus.classList.add('error');
        connectionStatus.classList.remove('connected');
        connectionStatus.innerHTML = '<span class="status-dot"></span><span>Disconnected</span>';

        // Retry connection
        setTimeout(checkConnection, 5000);
    }
}

async function loadProducts() {
    try {
        const response = await fetch(`${API_BASE}/products/`);
        if (!response.ok) throw new Error('Failed to fetch products');

        products = await response.json();
        updateDashboard();
        renderProductsTable();
        renderRecentProducts();
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
        showToast(
            `Sync complete! ${result.synced} products synced (${result.created} created, ${result.updated} updated)`,
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
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
        // If orders table doesn't exist in database, show sample data
        if (error.message.includes('relation "orders" does not exist')) {
            orders = getSampleOrders();
            renderOrdersTable();
        }
    }
}

function getSampleOrders() {
    // Sample data based on user's example
    return [
        { id: '1', order_number: 2719, courier: '1289', total_amount: 4247, status: 'DVD', delivery_charge: 211, folio: '15/10' },
        { id: '2', order_number: 2720, courier: 'RIDER', total_amount: 7697, status: 'DVD', delivery_charge: 247, folio: 'PC#143' },
        { id: '3', order_number: 2721, courier: '1287', total_amount: 3248, status: 'DVD', delivery_charge: 211, folio: '15/10' },
        { id: '4', order_number: 2722, courier: 'RIDER', total_amount: 8247, status: 'DVD', delivery_charge: 247, folio: 'PC#143' },
        { id: '5', order_number: 2724, courier: '1293', total_amount: 3247, status: 'RETURNED', delivery_charge: -211, folio: '22/10' },
        { id: '6', order_number: 2725, courier: '1292', total_amount: 5996, status: 'DVD', delivery_charge: 211, folio: '15/10' },
        { id: '7', order_number: 2726, courier: 'RIDER', total_amount: 6298, status: 'DVD', delivery_charge: 248, folio: 'PC#143' },
        { id: '8', order_number: 2727, courier: '1291', total_amount: 2998, status: 'DVD', delivery_charge: -159, folio: 'PC#144 / 08/10' },
        { id: '9', order_number: 2728, courier: '1285', total_amount: 2998, status: 'DVD', delivery_charge: 159, folio: '10-Aug' },
        { id: '10', order_number: 2729, courier: '1284', total_amount: 5998, status: 'DVD', delivery_charge: 211, folio: '15/10' },
        { id: '11', order_number: 2730, courier: '1283', total_amount: 5148, status: 'RETURNED', delivery_charge: -211, folio: '22/10' }
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
        renderRecentProducts();
    } catch (error) {
        console.error('Search error:', error);
    }
}

// UI Updates
function updateDashboard() {
    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (p.quantity || 0), 0);
    const lowStock = products.filter(p => p.quantity < 10).length;
    const totalValue = products.reduce((sum, p) => sum + ((p.price || 0) * (p.quantity || 0)), 0);

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

    tbody.innerHTML = products.map(product => `
        <tr>
            <td>
                ${product.image_url ? `<img src="${product.image_url}" alt="Product" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;">` : '<div style="width: 40px; height: 40px; background: rgba(255,255,255,0.1); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 10px;">No Img</div>'}
            </td>
            <td><strong>${escapeHtml(product.name)}</strong></td>
            <td>${Math.round(product.price || 0)}</td>
            <td>
                <span class="quantity-badge ${product.quantity < 10 ? 'low' : 'ok'}">
                    ${product.quantity}
                </span>
            </td>
            <td>${Math.round(product.cost_price || 0)}</td>
        </tr>
    `).join('');
}

function renderRecentProducts() {
    const tbody = document.getElementById('recentProductsTable');
    const recentProducts = products.slice(0, 5);

    if (recentProducts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No products yet. Add your first product!</td></tr>';
        return;
    }

    tbody.innerHTML = recentProducts.map(product => `
        <tr>
            <td><strong>${escapeHtml(product.name)}</strong></td>
            <td><code style="font-family: var(--font-mono); color: var(--text-secondary);">${escapeHtml(product.sku)}</code></td>
            <td>${escapeHtml(product.category || '-')}</td>
            <td>
                <span class="quantity-badge ${product.quantity < 10 ? 'low' : 'ok'}">
                    ${product.quantity}
                </span>
            </td>
            <td>${Math.round(product.price || 0)}</td>
        </tr>
    `).join('');
}

function populateProductSelect() {
    const select = document.getElementById('stockProduct');
    select.innerHTML = '<option value="">-- Select a product --</option>' +
        products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.quantity} in stock)</option>`).join('');
}

function renderOrdersTable() {
    const tbody = document.getElementById('ordersTable');

    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No orders found.</td></tr>';
        return;
    }

    tbody.innerHTML = orders.map(order => `
        <tr>
            <td><strong>${order.order_number || ''}</strong></td>
            <td>${escapeHtml(order.courier || '')}</td>
            <td>${order.total_amount ? order.total_amount.toLocaleString() : ''}</td>
            <td>
                <span style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; 
                    ${order.status === 'RETURNED' ? 'background: rgba(196, 92, 92, 0.2); color: var(--danger);' :
            'background: rgba(139, 92, 246, 0.2); color: var(--accent-primary);'}">
                    ${escapeHtml(order.status || '')}
                </span>
            </td>
            <td>${Math.round(order.delivery_charge || 0)}</td>
            <td>${escapeHtml(order.folio || '')}</td>
        </tr>
    `).join('');
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
                sku: document.getElementById('productSku').value,
                category: document.getElementById('productCategory').value || null,
                quantity: parseInt(document.getElementById('productQuantity').value) || 0,
                price: parseFloat(document.getElementById('productPrice').value) || 0,
                description: document.getElementById('productDescription').value || null
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
                sku: document.getElementById('editProductSku').value,
                category: document.getElementById('editProductCategory').value || null,
                quantity: parseInt(document.getElementById('editProductQuantity').value) || 0,
                price: parseFloat(document.getElementById('editProductPrice').value) || 0,
                description: document.getElementById('editProductDescription').value || null
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
    document.getElementById('editProductSku').value = product.sku;
    document.getElementById('editProductCategory').value = product.category || '';
    document.getElementById('editProductQuantity').value = product.quantity;
    document.getElementById('editProductPrice').value = product.price;
    document.getElementById('editProductDescription').value = product.description || '';

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

// Make functions globally accessible
window.openEditModal = openEditModal;
window.closeModal = closeModal;
window.deleteProduct = deleteProduct;
window.resetForm = resetForm;
window.syncShopifyProducts = syncShopifyProducts;

