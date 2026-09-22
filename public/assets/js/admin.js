// TinyMCE-editor + upload voor uitgelichte afbeelding
(function () {
  if (window.tinymce && document.getElementById('content-editor')) {
    tinymce.init({
      selector: '#content-editor',
      height: 620,
      menubar: 'edit insert format table tools',
      plugins: 'link image media table lists advlist autolink charmap code fullscreen preview searchreplace visualblocks wordcount',
      toolbar: 'undo redo | blocks | bold italic underline | forecolor | alignleft aligncenter alignright | bullist numlist | link image media table | removeformat | code fullscreen',
      license_key: 'gpl',
      branding: false,
      promotion: false,
      relative_urls: false,
      remove_script_host: true,
      convert_urls: true,
      entity_encoding: 'raw',
      content_style: "body { font-family: Inter, 'Segoe UI', sans-serif; font-size: 16px; max-width: 820px; margin: 0 auto; } img { max-width: 100%; height: auto; } table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 6px 10px; }",
      images_upload_url: '/admin/media/tinymce',
      automatic_uploads: true,
      images_upload_credentials: true,
    });
    // Bij verzenden formulier: TinyMCE-inhoud terugschrijven naar textarea
    var form = document.querySelector('.edit-layout');
    if (form) form.addEventListener('submit', function () { tinymce.triggerSave(); });
  }

  // Uitgelichte afbeelding uploaden
  var up = document.getElementById('featured-upload');
  var input = document.getElementById('featured-input');
  var preview = document.getElementById('featured-preview');
  if (up && input) {
    up.addEventListener('change', function () {
      if (!up.files.length) return;
      var fd = new FormData();
      fd.append('files', up.files[0]);
      fetch('/admin/media/upload?json=1', { method: 'POST', body: fd, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.files && res.files[0]) {
            input.value = res.files[0].url;
            preview.innerHTML = '<img src="' + res.files[0].url + '" alt="">';
          }
        })
        .catch(function (e) { alert('Upload mislukt: ' + e.message); });
    });
  }
})();
