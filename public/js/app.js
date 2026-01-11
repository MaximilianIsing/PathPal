// Main app utilities

// Mobile detection
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
         (window.innerWidth <= 768 && window.innerWidth <= window.innerHeight);
}

// Show desktop message if not on mobile
document.addEventListener('DOMContentLoaded', () => {
  if (!isMobileDevice()) {
    const desktopMsg = document.querySelector('.desktop-message');
    if (desktopMsg) {
      desktopMsg.classList.add('show');
    }
  }
});

// Detect if running as PWA (standalone mode)
function isStandaloneMode() {
  // Check for standalone mode
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  // iOS Safari
  if (window.navigator.standalone === true) {
    return true;
  }
  // Check if launched from homescreen (Android Chrome)
  if (window.matchMedia('(display-mode: fullscreen)').matches) {
    return true;
  }
  return false;
}

// Navigation menu toggle
document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('.menu-toggle');
  // Select the sidebar nav (not the header-nav-menu nav)
  const nav = document.querySelector('nav:not(.header-nav-menu)');
  const navLinks = document.querySelectorAll('nav:not(.header-nav-menu) a');
  
  if (menuToggle && nav) {
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      nav.classList.toggle('active');
    });
  }
  
  // Close nav when clicking outside
  document.addEventListener('click', (e) => {
    if (nav && nav.classList.contains('active')) {
      if (!nav.contains(e.target) && !menuToggle.contains(e.target)) {
        nav.classList.remove('active');
      }
    }
  });
  
  // Close nav when clicking a link
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      nav.classList.remove('active');
    });
  });
  
  // Add page transition blur effect for all navigation links
  const allNavLinks = document.querySelectorAll('a[href]');
  allNavLinks.forEach(link => {
    const href = link.getAttribute('href');
    const hasOnclick = link.getAttribute('onclick');
    
    // Skip external links, mailto, tel, anchors, and links with onclick handlers
    if (href && 
        !href.startsWith('http') && 
        !href.startsWith('mailto:') && 
        !href.startsWith('tel:') && 
        !href.startsWith('#') &&
        !hasOnclick) {
      
      link.addEventListener('click', (e) => {
        try {
          // Only apply transition if it's a different page
          const currentPath = window.location.pathname;
          let targetPath;
          
          // Handle relative and absolute paths
          if (href.startsWith('/')) {
            targetPath = href.split('?')[0]; // Remove query params
          } else {
            const url = new URL(link.href, window.location.origin);
            targetPath = url.pathname;
          }
          
          // Normalize paths (remove trailing slashes, handle index.html)
          const normalizePath = (path) => {
            path = path.replace(/\/$/, '') || '/';
            if (path.endsWith('/index.html') || path === '/index.html') {
              return '/';
            }
            return path;
          };
          
          const normalizedCurrent = normalizePath(currentPath);
          const normalizedTarget = normalizePath(targetPath);
          
          if (normalizedCurrent !== normalizedTarget) {
            // Apply blur transition
            document.body.classList.add('page-transitioning');
          }
        } catch (err) {
          // If URL parsing fails, still apply blur for safety
          document.body.classList.add('page-transitioning');
        }
      }, { passive: true });
    }
  });
  
  // Also handle programmatic navigation (window.location changes)
  let lastLocation = window.location.href;
  const checkLocationChange = () => {
    if (window.location.href !== lastLocation) {
      document.body.classList.add('page-transitioning');
      lastLocation = window.location.href;
    }
  };
  
  // Check for location changes periodically (for programmatic navigation)
  setInterval(checkLocationChange, 100);
  
  // Set active nav link based on current page
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  navLinks.forEach(link => {
    const linkPage = link.getAttribute('href');
    if (linkPage === currentPage || (currentPage === '' && linkPage === 'index.html')) {
      link.classList.add('active');
    }
  });
  
  // Also set active class for header nav in PC mode
  const headerNavLinks = document.querySelectorAll('.header-nav-menu a');
  headerNavLinks.forEach(link => {
    const linkPage = link.getAttribute('href');
    if (linkPage === currentPage || (currentPage === '' && linkPage === 'index.html')) {
      link.classList.add('active');
    }
  });
});

// Remove blur transition on page load
document.addEventListener('DOMContentLoaded', () => {
  // Remove any transition class that might have persisted
  document.body.classList.remove('page-transitioning');
});

// Also remove on page show (for back/forward navigation)
window.addEventListener('pageshow', () => {
  document.body.classList.remove('page-transitioning');
});

// Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('SW registered: ', registration);
      })
      .catch((registrationError) => {
        console.log('SW registration failed: ', registrationError);
      });
  });
}

// Format date
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Format percentage
function formatPercent(value) {
  return `${Math.round(value)}%`;
}

// Debounce function
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

// Show notification (subtle toast that doesn't shift layout)
function showNotification(message, type = 'info') {
  // If we're on a page with a local toast area (e.g., profile save),
  // prefer anchoring the toast to that container so it appears near the action.
  const localHost = document.querySelector('.save-profile-container');
  let container;

  if (localHost) {
    container = localHost.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      localHost.appendChild(container);
    }
  } else {
    // Fallback: global fixed container at bottom of viewport
    container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  
  // Auto-dismiss
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(4px)';
    setTimeout(() => toast.remove(), 250);
  }, 2400);
}

