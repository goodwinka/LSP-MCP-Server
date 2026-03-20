#include "mywidget.h"
#include <QString>

MyWidget::MyWidget(QWidget *parent) : QWidget(parent) {
    auto *layout = new QVBoxLayout(this);
    m_button = new QPushButton("Click me!", this);
    m_label = new QLabel("Clicks: 0", this);

    layout->addWidget(m_label);
    layout->addWidget(m_button);

    connect(m_button, &QPushButton::clicked, this, &MyWidget::onButtonClicked);
}

void MyWidget::onButtonClicked() {
    ++m_clickCount;
    m_label->setText(QString("Clicks: %1").arg(m_clickCount));
}
