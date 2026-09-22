// Stichting DUOS – interactie publiek deel
(function () {
  // Mobiel menu
  var navToggle = document.getElementById('nav-toggle');
  var nav = document.getElementById('main-nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      nav.classList.toggle('open');
    });
    // Submenu's op mobiel open/dicht klikken
    nav.querySelectorAll('li.has-sub > a').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (window.innerWidth <= 960) {
          var li = a.parentElement;
          if (!li.classList.contains('sub-open')) {
            e.preventDefault();
            li.classList.add('sub-open');
          } else if (a.getAttribute('href') === '#') {
            e.preventDefault();
            li.classList.remove('sub-open');
          }
        }
      });
    });
  }

  // Zoekpaneel
  var searchToggle = document.getElementById('search-toggle');
  var searchPanel = document.getElementById('search-panel');
  if (searchToggle && searchPanel) {
    searchToggle.addEventListener('click', function () {
      searchPanel.hidden = !searchPanel.hidden;
      if (!searchPanel.hidden) searchPanel.querySelector('input').focus();
    });
  }

  // Hero-slider
  var slider = document.getElementById('hero-slider');
  if (slider) {
    var slides = slider.querySelectorAll('.slide');
    if (slides.length > 1) {
      var idx = 0, timer = null;
      var dotsWrap = slider.querySelector('.slider-dots');
      slides.forEach(function (_, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', 'Slide ' + (i + 1));
        if (i === 0) b.classList.add('active');
        b.addEventListener('click', function () { go(i); restart(); });
        dotsWrap.appendChild(b);
      });
      var dots = dotsWrap.querySelectorAll('button');
      function go(i) {
        slides[idx].classList.remove('active');
        dots[idx].classList.remove('active');
        idx = (i + slides.length) % slides.length;
        slides[idx].classList.add('active');
        dots[idx].classList.add('active');
      }
      function restart() {
        clearInterval(timer);
        timer = setInterval(function () { go(idx + 1); }, 5500);
      }
      slider.querySelector('.prev').addEventListener('click', function () { go(idx - 1); restart(); });
      slider.querySelector('.next').addEventListener('click', function () { go(idx + 1); restart(); });
      restart();
    }
  }
})();
