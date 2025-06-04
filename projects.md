---
layout: projects
title: Projects
nav: true
description: These are example projects in the awesome jekyll theme
---

Here are some of our featured projects:

{% for project in site.projects %}
- [{{ project.title }}]({{ project.url }})
{% endfor %}
